// Send L-BTC or any held Liquid asset: pick the asset, enter destination +
// amount → review the fee → confirm (sign + broadcast). Amounts are entered in
// the asset's own precision (the sats/BTC denomination toggle applies only to
// L-BTC); the network fee is always paid in L-BTC. The QR scanner runs in a
// popup window (scanner.html) because MV3 side panels can't surface the camera
// permission prompt; it messages the scanned value back via apogee/qr-result.

import { useEffect, useState } from "react";
import { Check, ExternalLink, QrCode } from "lucide-react";
import type { AssetInfo, PrepareSendResult, SyncResult } from "@/engine/protocol";
import type { LiquidNetwork } from "@/keystore/keystore";
import { shortenHex } from "@/lib/utils";
import { formatAssetAmount, formatBtc, formatSats, parseAssetAmount } from "@/lib/format";
import { KNOWN_ASSETS } from "@/lib/asset-registry";
import { explorerTxUrl } from "@/lib/explorer";
import { Button, Card, CopyButton, ErrorText, Field, Input, Spinner } from "@/sidepanel/components/ui";
import { errMessage, wallet } from "@/sidepanel/wallet-client";

type Step = "form" | "review" | "sent";

/** Parse a scanned value: a bare address, or a BIP21-style
 *  `scheme:addr?amount=&assetid=` URI. The amount is returned as raw text —
 *  its unit depends on the asset (BTC for L-BTC, native units for a token), so
 *  interpretation happens at the call site where the asset is known. */
function parseQr(raw: string): { address: string; amountText?: string; assetId?: string } {
  const s = raw.trim();
  const m = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:([^?]+)(?:\?(.*))?$/);
  if (m) {
    const params = new URLSearchParams(m[2] ?? "");
    const amt = params.get("amount") ?? undefined;
    const assetId = params.get("assetid") ?? undefined;
    return { address: m[1], amountText: amt, assetId };
  }
  return { address: s };
}

/** Integer base units → a plain input-ready decimal string ("150.42", no
 *  grouping). String math, mirroring parseAssetAmount. */
function unitsToText(units: number, precision: number): string {
  const p = precision > 0 ? precision : 0;
  if (p === 0) return String(units);
  const s = String(units).padStart(p + 1, "0");
  const whole = s.slice(0, -p);
  const frac = s.slice(-p).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function openScanner(): void {
  void chrome.windows.create({
    url: chrome.runtime.getURL("src/scanner/scanner.html"),
    type: "popup",
    width: 420,
    height: 560,
  });
}

export function Send({
  onDone,
  sync,
  assets,
  initialAssetId,
  network,
  unit,
  isJade,
}: {
  onDone: () => void;
  sync: SyncResult | null;
  assets: Record<string, AssetInfo>;
  initialAssetId?: string;
  network: LiquidNetwork;
  unit: "btc" | "sats";
  isJade?: boolean;
}) {
  const [step, setStep] = useState<Step>("form");
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [assetSel, setAssetSel] = useState<string | null>(initialAssetId ?? null);
  const [prepared, setPrepared] = useState<PrepareSendResult | null>(null);
  const [txid, setTxid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drain, setDrain] = useState(false); // "Max" — send all of the asset
  const [autoLock, setAutoLock] = useState(15);
  const [password, setPassword] = useState("");
  // Auto-lock "never" steps up auth: a local send requires the password.
  const needsPassword = !isJade && autoLock === 0;

  // ---- asset resolution -----------------------------------------------------
  const policyHex = sync?.policyAssetHex ?? "";
  const assetId = assetSel ?? policyHex;
  const isLbtc = policyHex === "" || assetId === policyHex;
  // Precision + label resolve the same way the display path does (Tokens rows),
  // so the entered amount can never scale differently from what's shown.
  const precision = isLbtc
    ? 8
    : (KNOWN_ASSETS[assetId]?.precision ?? assets[assetId]?.precision ?? null);
  const assetLabel = isLbtc
    ? "L-BTC"
    : (KNOWN_ASSETS[assetId]?.label ??
      assets[assetId]?.ticker ??
      assets[assetId]?.name ??
      shortenHex(assetId, 6, 6));
  const lbtcSats = sync?.lbtcSats ?? 0;
  const balance = isLbtc ? lbtcSats : (sync?.balance[assetId] ?? 0);
  // Tokens the picker offers (positive balances only); the picker renders only
  // when at least one exists, so an L-BTC-only wallet keeps the plain form.
  const tokenIds = sync
    ? Object.entries(sync.balance)
        .filter(([a, amt]) => a !== policyHex && amt > 0)
        .map(([a]) => a)
    : [];

  const isBtc = unit === "btc";
  // The L-BTC amount is entered in the active denomination; tokens always enter
  // in their own precision. The engine works in base units either way.
  const unitLabel = isLbtc ? (isBtc ? "L-BTC" : "sats") : assetLabel;
  const enteredUnits = (() => {
    if (isLbtc) {
      const n = Number(amount);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return isBtc ? Math.round(n * 100_000_000) : Math.trunc(n);
    }
    return parseAssetAmount(amount, precision ?? 0) ?? 0;
  })();
  // What the recipient actually receives — the engine computes it. Falls back
  // to the entered amount before a build exists.
  const recipientUnits = prepared ? prepared.recipientSats : enteredUnits;

  /** Amount rendered for review/success in the right unit + label. */
  const amountLabel = (units: number): string =>
    isLbtc ? `${formatSats(units)} sats` : `${formatAssetAmount(units, precision)} ${assetLabel}`;

  /** The asset's full balance as input text (drain display). */
  const balanceText = (): string =>
    isLbtc
      ? isBtc
        ? (balance / 100_000_000).toFixed(8).replace(/\.?0+$/, "")
        : String(balance)
      : unitsToText(balance, precision ?? 0);

  // Receive the scanned address from the popup scanner window.
  useEffect(() => {
    const onMsg = (msg: unknown) => {
      if (!msg || typeof msg !== "object" || (msg as { type?: string }).type !== "apogee/qr-result") {
        return;
      }
      const raw = (msg as { value?: unknown }).value;
      if (typeof raw !== "string") return;
      const parsed = parseQr(raw);
      setAddress(parsed.address);
      setError("");
      // A BIP21 assetid switches the form to that asset — if the wallet holds it.
      if (parsed.assetId && parsed.assetId !== policyHex) {
        if ((sync?.balance[parsed.assetId] ?? 0) > 0) {
          setAssetSel(parsed.assetId);
          if (parsed.amountText) {
            // Elements BIP21 token amounts are decimal strings in asset units.
            setDrain(false);
            setAmount(parsed.amountText);
          }
        } else {
          setError("The scanned request is for an asset you don't hold.");
        }
        return;
      }
      if (parsed.amountText) {
        if (!isLbtc) return; // an L-BTC-denominated amount can't prefill a token form
        const btc = parseFloat(parsed.amountText);
        // Only accept a positive, finite amount; ignore negative/garbage so a
        // scanned URI can't prefill a bogus value.
        if (!Number.isFinite(btc) || btc <= 0) return;
        const sats = Math.round(btc * 100_000_000);
        // The scanned URI carries an explicit amount — that's the user's intent,
        // so it must drop an active "Max" (drain). Otherwise the form would show
        // the scanned amount while review silently builds a full-balance drain.
        setDrain(false);
        setAmount(isBtc ? (sats / 100_000_000).toFixed(8).replace(/\.?0+$/, "") : String(sats));
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, [isBtc, isLbtc, policyHex, sync]);

  // Keep the displayed "Max" amount in sync if the balance changes while Max is
  // active, so the field never shows a stale figure before review.
  useEffect(() => {
    if (!drain) return;
    setAmount(balanceText());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drain, balance, isBtc, assetId]);

  // Auto-lock "never" means the wallet never idle-locks, so sends step up auth.
  useEffect(() => {
    void wallet.getAutoLock().then(setAutoLock).catch(() => {});
  }, []);

  async function review() {
    setError("");
    if (!address.trim()) return setError("Enter a destination address.");
    if (drain) {
      if (balance <= 0) return setError("No funds available to send.");
    } else {
      if (enteredUnits <= 0) return setError(`Enter an amount in ${unitLabel}.`);
      if (enteredUnits > balance) return setError("Amount exceeds your available balance.");
      // L-BTC only: sending the entire balance as a fixed amount leaves no room
      // for the fee and always fails to build — steer to Max (fee taken from the
      // amount). For a token the fee is paid in L-BTC, so a full-balance fixed
      // send is valid and proceeds.
      if (isLbtc && enteredUnits === balance) {
        return setError("To send your full balance, use Max — the network fee is taken from the amount.");
      }
    }
    // Token sends still pay the network fee in L-BTC — fail fast with the cause
    // (the engine double-guards).
    if (!isLbtc && lbtcSats <= 0) {
      return setError("You need L-BTC to pay the network fee — this wallet has none.");
    }
    setBusy(true);
    try {
      setPrepared(
        await wallet.prepareSend(
          address.trim(),
          drain ? balance : enteredUnits,
          drain,
          isLbtc ? undefined : assetId,
        ),
      );
      setStep("review");
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function setMax() {
    setError("");
    setDrain(true);
    setAmount(balanceText());
  }

  function onAmountChange(v: string) {
    setDrain(false);
    setAmount(v);
  }

  function onAssetChange(id: string) {
    setAssetSel(id);
    setAmount("");
    setDrain(false);
    setError("");
  }

  async function confirm() {
    if (!prepared) return;
    setBusy(true);
    setError("");
    try {
      // Pass the review so a Jade send can show the summary in its signing tab.
      const review = {
        address: address.trim(),
        recipientSats: prepared.recipientSats,
        fee: prepared.fee,
        drain,
        ...(isLbtc
          ? {}
          : { assetId, assetTicker: assetLabel, assetPrecision: precision }),
      };
      setTxid((await wallet.send(prepared.pset, review, needsPassword ? password : undefined)).txid);
      setStep("sent");
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (step === "sent") {
    const explorer = explorerTxUrl(network, txid);
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 pt-1 text-center">
          <span className="apogee-pop flex size-14 items-center justify-center rounded-full bg-[color:var(--success-bg)] text-[color:var(--success-text)]">
            <Check size={30} strokeWidth={2.5} />
          </span>
          <div className="flex flex-col gap-0.5">
            <h2 className="text-lg font-semibold text-[color:var(--text-strong)]">Sent</h2>
            <p className="text-sm text-[color:var(--text-secondary)]">
              {amountLabel(recipientUnits)} on their way
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--surface-soft)] px-3 py-2">
          <span className="truncate font-mono text-xs text-[color:var(--text-secondary)]">
            {shortenHex(txid, 10, 8)}
          </span>
          <CopyButton value={txid} label="Copy" />
        </div>
        {explorer && (
          <a
            href={explorer}
            target="_blank"
            rel="noreferrer"
            className="mt-2 flex items-center justify-center gap-1 text-xs text-[color:var(--accent)] hover:underline"
          >
            View transaction
            <ExternalLink size={12} />
          </a>
        )}
        <Button className="mt-4 w-full" onClick={onDone}>
          Done
        </Button>
      </Card>
    );
  }

  if (step === "review" && prepared) {
    return (
      <Card>
        <h2 className="mb-2 text-center console-overline console-ruled--center">
          Review
        </h2>
        <dl className="flex flex-col gap-1.5 text-sm">
          <Row label="To" value={shortenHex(address.trim(), 10, 8)} mono />
          <Row
            label={drain ? "Amount (max)" : "Amount"}
            value={amountLabel(recipientUnits)}
            console
          />
          <Row label="Network fee" value={`${formatSats(prepared.fee)} sats`} console />
          {/* A cross-asset total is meaningless — only L-BTC sums with its fee. */}
          {isLbtc && (
            <Row
              label="Total"
              value={`${formatSats(recipientUnits + prepared.fee)} sats`}
              strong
              console
            />
          )}
        </dl>
        {!isLbtc && (
          <p className="mt-1.5 text-xs text-[color:var(--text-subtle)]">
            The network fee is paid in L-BTC.
          </p>
        )}
        <ErrorText>{error}</ErrorText>
        {isJade && (
          <p className="mt-1 text-center text-xs text-[color:var(--text-subtle)]">
            {busy
              ? "Approve the transaction on your Jade in the window that opened…"
              : "You'll sign on your Jade — a window opens when you confirm."}
          </p>
        )}
        {needsPassword && (
          <Field label="Password (auto-lock is off)">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </Field>
        )}
        <div className="mt-3 flex flex-col gap-2">
          <Button onClick={confirm} disabled={busy || (needsPassword && !password)}>
            {busy ? <Spinner /> : "Confirm & send"}
          </Button>
          <Button variant="secondary" onClick={() => setStep("form")} disabled={busy}>
            Back
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="mb-3 text-center console-overline console-ruled--center">
        Send {assetLabel}
      </h2>
      <div className="mb-4 flex flex-col items-center gap-0.5">
        <span className="text-xs text-[color:var(--text-subtle)]">Available balance</span>
        <span className="console-value text-lg">
          {isLbtc
            ? isBtc
              ? `${formatBtc(balance)} L-BTC`
              : `${formatSats(balance)} sats`
            : `${formatAssetAmount(balance, precision)} ${assetLabel}`}
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {tokenIds.length > 0 && (
          <Field label="Asset">
            <select
              value={assetId}
              onChange={(e) => onAssetChange(e.target.value)}
              className="console-select h-11 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] px-3 text-sm text-[color:var(--text-strong)] outline-none focus:border-[color:var(--accent)]"
            >
              <option value={policyHex}>L-BTC</option>
              {tokenIds.map((id) => (
                <option key={id} value={id}>
                  {KNOWN_ASSETS[id]?.label ??
                    assets[id]?.ticker ??
                    assets[id]?.name ??
                    shortenHex(id, 6, 6)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Destination address">
          <div className="flex gap-2">
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="lq1… / tlq1…"
              autoFocus
            />
            <Button
              variant="secondary"
              className="shrink-0 px-3"
              aria-label="Scan QR code"
              onClick={openScanner}
            >
              <QrCode size={18} />
            </Button>
          </div>
        </Field>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[color:var(--text-secondary)]">
              Amount ({unitLabel})
            </span>
            <button
              type="button"
              onClick={setMax}
              className="text-xs font-semibold text-[color:var(--accent)] hover:underline"
            >
              Max
            </button>
          </div>
          <Input
            className="console-value text-[15px]"
            type="number"
            inputMode={isLbtc && !isBtc ? "numeric" : "decimal"}
            min={0}
            step={
              isLbtc
                ? isBtc
                  ? "0.00000001"
                  : 1
                : precision && precision > 0
                  ? `0.${"0".repeat(precision - 1)}1`
                  : 1
            }
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
            placeholder={
              isLbtc
                ? isBtc
                  ? "0.00000000"
                  : "0"
                : precision && precision > 0
                  ? `0.${"0".repeat(Math.min(precision, 2))}`
                  : "0"
            }
          />
          {drain && (
            <p className="px-1 text-xs text-[color:var(--text-subtle)]">
              {isLbtc
                ? "Sending all funds. The network fee is deducted from this amount."
                : `Sending your full ${assetLabel} balance. The network fee is paid in L-BTC.`}
            </p>
          )}
        </div>
        <ErrorText>{error}</ErrorText>
        <Button onClick={review} disabled={busy}>
          {busy ? <Spinner /> : "Review"}
        </Button>
      </div>
    </Card>
  );
}

function Row({
  label,
  value,
  mono,
  strong,
  console: consoleValue,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
  console?: boolean; // telemetry-face readout (sats amounts)
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[color:var(--text-subtle)]">{label}</dt>
      <dd
        className={[
          "truncate",
          mono ? "font-mono" : "",
          consoleValue ? "console-value" : "",
          strong ? "font-semibold text-[color:var(--text-strong)]" : "text-[color:var(--text-primary)]",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}
