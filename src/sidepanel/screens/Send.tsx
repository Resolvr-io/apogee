// Send L-BTC: enter destination + amount → review the fee → confirm (sign +
// broadcast). The QR scanner runs in a popup window (scanner.html) because MV3
// side panels can't surface the camera permission prompt; it messages the
// scanned value back via apogee/qr-result.

import { useEffect, useState } from "react";
import { Check, ExternalLink, QrCode } from "lucide-react";
import type { PrepareSendResult } from "@/engine/protocol";
import type { LiquidNetwork } from "@/keystore/keystore";
import { shortenHex } from "@/lib/utils";
import { formatBtc, formatSats } from "@/lib/format";
import { explorerTxUrl } from "@/lib/explorer";
import { Button, Card, CopyButton, ErrorText, Field, Input, Spinner } from "@/sidepanel/components/ui";
import { errMessage, wallet } from "@/sidepanel/wallet-client";

type Step = "form" | "review" | "sent";

/** Parse a scanned value: a bare address, or a BIP21-style `scheme:addr?amount=`
 *  URI (amount is in BTC → sats). */
function parseQr(raw: string): { address: string; sats?: number } {
  const s = raw.trim();
  const m = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:([^?]+)(?:\?(.*))?$/);
  if (m) {
    const amt = new URLSearchParams(m[2] ?? "").get("amount");
    const btc = amt ? parseFloat(amt) : NaN;
    // Only accept a positive, finite amount; ignore negative/garbage so a scanned
    // URI can't prefill a bogus value.
    const sats = Number.isFinite(btc) && btc > 0 ? Math.round(btc * 100_000_000) : undefined;
    return { address: m[1], sats };
  }
  return { address: s };
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
  maxSats,
  network,
  unit,
  isJade,
}: {
  onDone: () => void;
  maxSats: number;
  network: LiquidNetwork;
  unit: "btc" | "sats";
  isJade?: boolean;
}) {
  const [step, setStep] = useState<Step>("form");
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [prepared, setPrepared] = useState<PrepareSendResult | null>(null);
  const [txid, setTxid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drain, setDrain] = useState(false); // "Max" — send all funds
  const [autoLock, setAutoLock] = useState(15);
  const [password, setPassword] = useState("");
  // Auto-lock "never" steps up auth: a local send requires the password.
  const needsPassword = !isJade && autoLock === 0;

  const isBtc = unit === "btc";
  const unitLabel = isBtc ? "L-BTC" : "sats";
  // The amount is entered in the active unit; the engine always works in sats.
  const enteredSats = (() => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return isBtc ? Math.round(n * 100_000_000) : Math.trunc(n);
  })();
  // What the recipient actually receives — the engine computes it (drain takes
  // the fee from the amount; explicit sends adjust too). Falls back to the
  // entered amount before a build exists.
  const recipientSats = prepared ? prepared.recipientSats : enteredSats;

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
      if (parsed.sats) {
        // The scanned URI carries an explicit amount — that's the user's intent,
        // so it must drop an active "Max" (drain). Otherwise the form would show
        // the scanned amount while review silently builds a full-balance drain.
        setDrain(false);
        setAmount(
          isBtc ? (parsed.sats / 100_000_000).toFixed(8).replace(/\.?0+$/, "") : String(parsed.sats),
        );
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, [isBtc]);

  // Keep the displayed "Max" amount in sync if the balance changes while Max is
  // active, so the field never shows a stale figure before review.
  useEffect(() => {
    if (!drain) return;
    setAmount(isBtc ? (maxSats / 100_000_000).toFixed(8).replace(/\.?0+$/, "") : String(maxSats));
  }, [drain, maxSats, isBtc]);

  // Auto-lock "never" means the wallet never idle-locks, so sends step up auth.
  useEffect(() => {
    void wallet.getAutoLock().then(setAutoLock).catch(() => {});
  }, []);

  async function review() {
    setError("");
    if (!address.trim()) return setError("Enter a destination address.");
    if (drain) {
      if (maxSats <= 0) return setError("No funds available to send.");
    } else {
      if (enteredSats <= 0) return setError(`Enter an amount in ${unitLabel}.`);
      if (enteredSats > maxSats) return setError("Amount exceeds your available balance.");
      // Sending the entire balance as a fixed amount leaves no room for the fee and
      // always fails to build — steer the user to Max (fee taken from the amount).
      if (enteredSats === maxSats) {
        return setError("To send your full balance, use Max — the network fee is taken from the amount.");
      }
    }
    setBusy(true);
    try {
      setPrepared(await wallet.prepareSend(address.trim(), drain ? maxSats : enteredSats, drain));
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
    setAmount(isBtc ? (maxSats / 100_000_000).toFixed(8).replace(/\.?0+$/, "") : String(maxSats));
  }

  function onAmountChange(v: string) {
    setDrain(false);
    setAmount(v);
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
              {formatSats(recipientSats)} sats on their way
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
          <Row label={drain ? "Amount (max)" : "Amount"} value={`${formatSats(recipientSats)} sats`} console />
          <Row label="Network fee" value={`${formatSats(prepared.fee)} sats`} console />
          <Row label="Total" value={`${formatSats(recipientSats + prepared.fee)} sats`} strong console />
        </dl>
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
        Send L-BTC
      </h2>
      <div className="mb-4 flex flex-col items-center gap-0.5">
        <span className="text-xs text-[color:var(--text-subtle)]">Available balance</span>
        <span className="console-value text-lg">
          {isBtc ? `${formatBtc(maxSats)} L-BTC` : `${formatSats(maxSats)} sats`}
        </span>
      </div>
      <div className="flex flex-col gap-3">
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
            inputMode={isBtc ? "decimal" : "numeric"}
            min={isBtc ? 0 : 1}
            step={isBtc ? "0.00000001" : 1}
            max={(isBtc ? maxSats / 100_000_000 : maxSats) || undefined}
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
            placeholder={isBtc ? "0.00000000" : "0"}
          />
          {drain && (
            <p className="px-1 text-xs text-[color:var(--text-subtle)]">
              Sending all funds. The network fee is deducted from this amount.
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
