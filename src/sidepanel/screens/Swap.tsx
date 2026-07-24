// Instant swap via SideSwap: pick the asset to send and the asset to receive,
// enter an amount → review the swap → confirm (execute). The full orchestration
// (getUtxos → startQuotes → getQuote → signSwapPset → takerSign) runs in the
// service worker via wallet/swap. Amounts are entered in the asset's own
// precision, matching the Send screen.

import { useState } from "react";
import { ArrowDown, Check, ExternalLink } from "lucide-react";
import type { AssetInfo, SwapResultDTO, SyncResult } from "@/engine/protocol";
import type { LiquidNetwork } from "@/keystore/keystore";
import { shortenHex } from "@/lib/utils";
import { formatAssetAmount, formatSats, parseAssetAmount } from "@/lib/format";
import { KNOWN_ASSETS } from "@/lib/asset-registry";
import { explorerTxUrl } from "@/lib/explorer";
import { Button, Card, CopyButton, ErrorText, Field, Input, Spinner } from "@/sidepanel/components/ui";
import { AssetSelect } from "@/sidepanel/components/AssetSelect";
import { errMessage, wallet } from "@/sidepanel/wallet-client";

type Step = "form" | "review" | "swapping" | "done";

export function Swap({
  onDone,
  sync,
  assets,
  network,
}: {
  onDone: () => void;
  sync: SyncResult | null;
  assets: Record<string, AssetInfo>;
  network: LiquidNetwork;
}) {
  const [step, setStep] = useState<Step>("form");
  const [sendAssetId, setSendAssetId] = useState<string>("");
  const [recvAssetId, setRecvAssetId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [result, setResult] = useState<SwapResultDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // ---- asset resolution -----------------------------------------------------
  const policyHex = sync?.policyAssetHex ?? "";
  const sendId = sendAssetId || policyHex;
  const recvId = recvAssetId || "";

  const sendPrecision = sendId === policyHex
    ? 8
    : (KNOWN_ASSETS[sendId]?.precision ?? assets[sendId]?.precision ?? null);
  const sendLabel = sendId === policyHex
    ? "LBTC"
    : (KNOWN_ASSETS[sendId]?.label ??
      assets[sendId]?.ticker ??
      assets[sendId]?.name ??
      shortenHex(sendId, 6, 6));

  const recvPrecision = recvId === policyHex
    ? 8
    : (KNOWN_ASSETS[recvId]?.precision ?? assets[recvId]?.precision ?? null);
  const recvLabel = recvId === policyHex
    ? "LBTC"
    : (KNOWN_ASSETS[recvId]?.label ??
      assets[recvId]?.ticker ??
      assets[recvId]?.name ??
      shortenHex(recvId, 6, 6));

  const sendBalance = sendId === policyHex
    ? (sync?.lbtcSats ?? 0)
    : (sync?.balance[sendId] ?? 0);

  // Held assets with positive balances for the "from" picker.
  const heldAssetIds = sync
    ? Object.entries(sync.balance)
        .filter(([, amt]) => amt > 0)
        .map(([id]) => id)
    : [policyHex];

  // All known assets for the "to" picker (policy asset + held + known tokens).
  const allAssetIds = Array.from(new Set([policyHex, ...heldAssetIds, ...Object.keys(KNOWN_ASSETS)]));

  // Parse the entered amount into base units.
  const enteredUnits = (() => {
    const prec = sendId === policyHex ? 8 : (sendPrecision ?? 0);
    if (sendId === policyHex) {
      const n = Number(amount);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return Math.round(n * 100_000_000);
    }
    return parseAssetAmount(amount, prec) ?? 0;
  })();

  const sendUnitLabel = sendId === policyHex
    ? "LBTC"
    : sendPrecision == null
      ? `${sendLabel} base units`
      : sendLabel;

  function onSendAssetChange(id: string) {
    setSendAssetId(id);
    setAmount("");
    setError("");
  }

  function onRecvAssetChange(id: string) {
    setRecvAssetId(id);
    setError("");
  }

  function setMax() {
    setError("");
    if (sendId === policyHex) {
      setAmount(String(sendBalance));
    } else {
      const prec = sendPrecision ?? 0;
      const p = prec > 0 ? prec : 0;
      if (p === 0) {
        setAmount(String(sendBalance));
      } else {
        const s = String(sendBalance).padStart(p + 1, "0");
        const whole = s.slice(0, -p);
        const frac = s.slice(-p).replace(/0+$/, "");
        setAmount(frac ? `${whole}.${frac}` : whole);
      }
    }
  }

  function review() {
    setError("");
    if (!recvId) return setError("Select an asset to receive.");
    if (sendId === recvId) return setError("Select two different assets to swap.");
    if (enteredUnits <= 0) return setError(`Enter an amount in ${sendUnitLabel}.`);
    if (enteredUnits > sendBalance) return setError("Amount exceeds your available balance.");
    setStep("review");
  }

  async function executeSwap() {
    setBusy(true);
    setError("");
    setStep("swapping");
    try {
      const res = await wallet.swap(sendId, recvId, enteredUnits);
      setResult(res);
      setStep("done");
    } catch (e) {
      setError(errMessage(e));
      setStep("form");
    } finally {
      setBusy(false);
    }
  }

  // ---- done -----------------------------------------------------------------
  if (step === "done" && result) {
    const explorer = explorerTxUrl(network, result.txid);
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 pt-1 text-center">
          <span className="apogee-pop flex size-14 items-center justify-center rounded-full bg-[color:var(--success-bg)] text-[color:var(--success-text)]">
            <Check size={30} strokeWidth={2.5} />
          </span>
          <div className="flex flex-col gap-0.5">
            <h2 className="text-lg font-semibold text-[color:var(--text-strong)]">Swap complete</h2>
            <p className="text-sm text-[color:var(--text-secondary)]">
              {formatAssetAmount(Number(result.sent), sendPrecision)} {sendLabel}{" → "}
              {formatAssetAmount(Number(result.received), recvPrecision)} {recvLabel}
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--surface-soft)] px-3 py-2">
          <span className="text-xs text-[color:var(--text-secondary)]">
            Network fee: {formatSats(Number(result.fee))} sats
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--surface-soft)] px-3 py-2">
          <span className="truncate font-mono text-xs text-[color:var(--text-secondary)]">
            {shortenHex(result.txid, 10, 8)}
          </span>
          <CopyButton value={result.txid} label="Copy" />
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

  // ---- swapping (processing) ------------------------------------------------
  if (step === "swapping") {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 pt-4 text-center">
          <Spinner />
          <p className="text-sm text-[color:var(--text-secondary)]">
            Finding the best price and signing the swap…
          </p>
          <p className="text-xs text-[color:var(--text-subtle)]">
            This usually takes a few seconds.
          </p>
        </div>
      </Card>
    );
  }

  // ---- review ---------------------------------------------------------------
  if (step === "review") {
    return (
      <Card>
        <h2 className="mb-2 text-center console-overline console-ruled--center">
          Review Swap
        </h2>
        <dl className="flex flex-col gap-1.5 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-[color:var(--text-subtle)]">You pay</dt>
            <dd className="console-value font-semibold text-[color:var(--text-strong)]">
              {formatAssetAmount(enteredUnits, sendPrecision)} {sendLabel}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-[color:var(--text-subtle)]">You receive (est.)</dt>
            <dd className="console-value font-semibold text-[color:var(--text-strong)]">
              {recvLabel}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-[color:var(--text-subtle)]">Network fee</dt>
            <dd className="text-[color:var(--text-primary)]">~1000 sats (max)</dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-[color:var(--text-subtle)]">
          The exact receive amount is set by the dealer's quote. The swap is
          verified before signing — if the rate changed unfavorably, the
          transaction will not sign.
        </p>
        <ErrorText>{error}</ErrorText>
        <div className="mt-3 flex flex-col gap-2">
          <Button onClick={executeSwap} disabled={busy}>
            {busy ? <Spinner /> : "Confirm swap"}
          </Button>
          <Button variant="secondary" onClick={() => setStep("form")} disabled={busy}>
            Back
          </Button>
        </div>
      </Card>
    );
  }

  // ---- form -----------------------------------------------------------------
  return (
    <Card>
      <h2 className="mb-3 text-center console-overline console-ruled--center">
        Swap
      </h2>
      <div className="flex flex-col gap-3">
        {/* Send asset + amount */}
        <Field label="You send">
          <AssetSelect
            network={network}
            value={sendId}
            onChange={onSendAssetChange}
            options={heldAssetIds.map((id) => ({
              id,
              label:
                id === policyHex
                  ? "LBTC"
                  : (KNOWN_ASSETS[id]?.label ??
                    assets[id]?.ticker ??
                    assets[id]?.name ??
                    shortenHex(id, 6, 6)),
            }))}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[color:var(--text-secondary)]">
              Amount ({sendUnitLabel})
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-[color:var(--text-subtle)]">
                Balance: {sendId === policyHex ? formatSats(sendBalance) : formatAssetAmount(sendBalance, sendPrecision)} {sendLabel}
              </span>
              <button
                type="button"
                onClick={setMax}
                className="text-xs font-semibold text-[color:var(--accent)] hover:underline"
              >
                Max
              </button>
            </div>
          </div>
          <Input
            className="console-value text-[15px]"
            type="number"
            inputMode="decimal"
            min={0}
            step={
              sendId === policyHex
                ? "0.00000001"
                : sendPrecision && sendPrecision > 0
                  ? `0.${"0".repeat(sendPrecision - 1)}1`
                  : 1
            }
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={
              sendId === policyHex
                ? "0.00000000"
                : sendPrecision && sendPrecision > 0
                  ? `0.${"0".repeat(Math.min(sendPrecision, 2))}`
                  : "0"
            }
          />
        </div>

        {/* Direction indicator */}
        <div className="flex justify-center">
          <span className="flex size-8 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:var(--surface-soft)] text-[color:var(--text-secondary)]">
            <ArrowDown size={16} />
          </span>
        </div>

        {/* Receive asset */}
        <Field label="You receive">
          <AssetSelect
            network={network}
            value={recvId}
            onChange={onRecvAssetChange}
            options={allAssetIds
              .filter((id) => id !== sendId)
              .map((id) => ({
                id,
                label:
                  id === policyHex
                    ? "LBTC"
                    : (KNOWN_ASSETS[id]?.label ??
                      assets[id]?.ticker ??
                      assets[id]?.name ??
                      shortenHex(id, 6, 6)),
              }))}
          />
        </Field>

        <ErrorText>{error}</ErrorText>
        <Button onClick={review} disabled={busy}>
          {busy ? <Spinner /> : "Review"}
        </Button>
      </div>
    </Card>
  );
}
