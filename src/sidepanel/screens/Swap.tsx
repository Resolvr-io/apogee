// Instant swap via SideSwap: pick the asset to send and the asset to receive,
// enter an amount → review the swap → confirm (execute). The full orchestration
// (getUtxos → startQuotes → getQuote → signSwapPset → takerSign) runs in the
// service worker via wallet/swap. Amounts are entered in the asset's own
// precision, matching the Send screen. The denomination toggle (sats/BTC)
// applies to LBTC only, also matching Send.

import { useEffect, useState } from "react";
import { ArrowDown, Check, ExternalLink } from "lucide-react";
import type { AssetInfo, SwapQuotePreview, SwapResultDTO, SyncResult } from "@/engine/protocol";
import type { LiquidNetwork } from "@/keystore/keystore";
import { shortenHex } from "@/lib/utils";
import { formatAssetAmount, formatBtc, formatSats, parseAssetAmount } from "@/lib/format";
import {
  KNOWN_ASSETS,
  LBTC_MAINNET_ASSET_ID,
  LBTC_TESTNET_ASSET_ID,
  USDT_LIQUID_ASSET_ID,
  USDT_TESTNET_ASSET_ID,
} from "@/lib/asset-registry";
import { explorerTxUrl } from "@/lib/explorer";
import { Button, Card, CopyButton, ErrorText, Field, Input, Spinner } from "@/sidepanel/components/ui";
import { AssetSelect } from "@/sidepanel/components/AssetSelect";
import {
  lowBalanceAvailable,
  swapErrorKind,
  swapErrorMessage,
  wallet,
} from "@/sidepanel/wallet-client";
import { SWAP_MAX_FEE_SATS } from "@/sideswap/constants";

type Step = "form" | "review" | "swapping" | "done";

export function Swap({
  onDone,
  sync,
  assets,
  network,
  unit,
  initialSendAssetId,
}: {
  onDone: () => void;
  sync: SyncResult | null;
  assets: Record<string, AssetInfo>;
  network: LiquidNetwork;
  unit: "btc" | "sats";
  /** Pre-select the send asset (e.g. when launched from a token drawer). */
  initialSendAssetId?: string;
}) {
  const [step, setStep] = useState<Step>("form");
  const [sendAssetId, setSendAssetId] = useState<string>(initialSendAssetId ?? "");
  const [recvAssetId, setRecvAssetId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [result, setResult] = useState<SwapResultDTO | null>(null);
  const [quote, setQuote] = useState<SwapQuotePreview | null>(null);
  // Reverse-input: USD target amount on the receive side (when receiving a
  // USD-pegged asset like USDt). Typing here auto-calculates the BTC send amount.
  const [recvInput, setRecvInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Never-auto-lock step-up — swap signs a transaction, so a never-auto-locking
  // wallet re-confirms the password (same gate as the Send screen).
  const [autoLock, setAutoLock] = useState(15);
  const [password, setPassword] = useState("");
  // The service worker is the authority on whether a step-up is required (it reads
  // auto-lock from storage itself). This local flag is advisory, and `getAutoLock`
  // can fail — leaving it at the default 15 for a wallet that is actually
  // never-auto-lock. In that case the SW rejects with the step-up prompt, so also
  // treat that error as "password required": otherwise the user is told to enter a
  // password with no field to type it into, and every retry fails identically.
  const stepUpRejected = error.startsWith("Enter your password to swap");
  // Renders the field / gates Confirm. Includes the SW-rejected case so the UI can
  // always satisfy the SW's demand.
  const needsPassword = autoLock === 0 || stepUpRejected;
  // Pre-flight check only. Deliberately NOT `needsPassword`: if it were, the
  // rejection error would latch the local guard on and short-circuit before the
  // SW is consulted, so a wallet whose auto-lock is genuinely non-zero could never
  // clear the error. The SW re-checks regardless, so this is purely a UX shortcut.
  const requiresPasswordLocally = autoLock === 0;
  // True when the review-screen quote preview failed — surfaced with a Retry
  // instead of leaving the user on a disabled "Waiting for quote…" button.
  const [quoteError, setQuoteError] = useState(false);
  // The dealer's fillable amount when it refuses for LowBalance, so the error can
  // tell the user what size WOULD work rather than just "too big".
  const [availableUnits, setAvailableUnits] = useState<bigint | null>(null);
  // Ticks once a second while a quote is live so the expiry countdown re-renders.
  const [now, setNow] = useState(() => Date.now());

  // Local denomination toggle — initialized from the parent's global setting,
  // but tappable inline so the user can switch without leaving the swap form.
  const [localUnit, setLocalUnit] = useState<"btc" | "sats">(unit === "btc" ? "btc" : "sats");
  const isBtc = localUnit === "btc";

  // BTC→USD rate for showing dollar equivalents on both sides of the swap.
  const [btcRate, setBtcRate] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    wallet.getRate("USD").then((r) => alive && setBtcRate(r)).catch(() => {});
    wallet.getAutoLock().then((m) => alive && setAutoLock(m)).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Quote expiry. SideSwap quotes carry a ttl and `taker_sign` only accepts a
  // live quote_id, so a stale Confirm is guaranteed to fail — after burning a
  // password step-up round trip. Tick while a quote is live so the countdown
  // renders and Confirm disarms the moment it lapses; the interval is torn down
  // once expired (no point re-rendering a dead quote).
  const quoteExpiresAt = quote?.expiresAt ?? null;
  const quoteExpired = quoteExpiresAt != null && now >= quoteExpiresAt;
  useEffect(() => {
    if (quoteExpiresAt == null) return;
    setNow(Date.now()); // resync immediately on a fresh quote
    if (Date.now() >= quoteExpiresAt) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= quoteExpiresAt) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [quoteExpiresAt]);
  const secsLeft =
    quoteExpiresAt == null ? null : Math.max(0, Math.ceil((quoteExpiresAt - now) / 1000));

  // ---- asset resolution -----------------------------------------------------
  const policyHex = sync?.policyAssetHex ?? "";

  // Held assets with positive balances for the "from" picker. Always include
  // the policy asset (LBTC) so the form defaults to LBTC→USDt even when the
  // user holds 0 LBTC (they'll get a balance error on review, which is clear).
  const heldAssetIds = sync
    ? Array.from(new Set([
        policyHex,
        ...Object.entries(sync.balance)
          .filter(([, amt]) => amt > 0)
          .map(([id]) => id),
      ]))
    : [policyHex];

  // Default to LBTC as the send asset — the most common swap direction.
  const sendId = sendAssetId || policyHex;

  // All known assets for the "to" picker, filtered to the active network so
  // testnet wallets don't show mainnet USDt or vice versa.
  const knownIdsForNetwork = Object.keys(KNOWN_ASSETS).filter((id) => {
    if (network === "liquid") return id !== LBTC_TESTNET_ASSET_ID && id !== USDT_TESTNET_ASSET_ID;
    // testnet / regtest: exclude mainnet LBTC and mainnet USDt
    return id !== LBTC_MAINNET_ASSET_ID && id !== USDT_LIQUID_ASSET_ID;
  });
  const allAssetIds = Array.from(new Set([policyHex, ...heldAssetIds, ...knownIdsForNetwork]));

  // Auto-select the first available receive asset when none is chosen, so the
  // user doesn't have to manually pick from a dropdown when there's an obvious
  // default (e.g. only USDT available).
  const firstRecvId = allAssetIds.find((id) => id !== sendId) ?? "";
  const recvId = recvAssetId || firstRecvId;

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

  /** Parse a send-amount string into base units, respecting the active
   *  denomination (BTC decimals vs. sats integer) for LBTC. */
  function computeSendUnits(val: string): number {
    const prec = sendId === policyHex ? 8 : (sendPrecision ?? 0);
    if (sendId === policyHex) {
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return isBtc ? Math.round(n * 100_000_000) : Math.round(n);
    }
    return parseAssetAmount(val, prec) ?? 0;
  }

  const enteredUnits = computeSendUnits(amount);

  const sendUnitLabel = sendId === policyHex
    ? isBtc ? "LBTC" : "sats"
    : sendPrecision == null
      ? `${sendLabel} base units`
      : sendLabel;

  /** Format an LBTC sats amount in the active denomination. */
  function fmtLbtc(sats: number): string {
    return isBtc ? formatBtc(sats) : formatSats(sats);
  }

  /** True when the receive asset is a USD-pegged stablecoin (e.g. USDt). */
  const recvIsUsd = recvId ? Boolean(KNOWN_ASSETS[recvId]?.pegUsd) : false;
  /** True when the send asset is a USD-pegged stablecoin. */
  const sendIsUsd = Boolean(KNOWN_ASSETS[sendId]?.pegUsd);

  /** Dollar value of an LBTC sats amount, or null when no rate. */
  function lbtcToUsd(sats: number): number | null {
    if (!btcRate) return null;
    return (sats / 100_000_000) * btcRate;
  }

  /** Format a USD amount as "$X.XX". */
  function fmtUsd(usd: number): string {
    return usd.toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  /** USD equivalent of the entered send amount, or null. */
  const sendUsd = (() => {
    if (enteredUnits <= 0) return null;
    if (sendId === policyHex) return lbtcToUsd(enteredUnits);
    if (sendIsUsd) return enteredUnits / 10 ** (sendPrecision ?? 8);
    return null;
  })();

  /** Estimated receive amount as a display string for the receive input,
   *  computed from the BTC/USD rate before a dealer quote arrives.
   *  Only populated when the user is driving from the send side. */
  const estRecvDisplay = (() => {
    if (quote) return "";
    if (enteredUnits <= 0 || !recvId || !btcRate) return "";
    // USDt → LBTC: convert USD to sats
    if (sendIsUsd && recvId === policyHex) {
      const usdVal = enteredUnits / 10 ** (sendPrecision ?? 8);
      const estSats = Math.round((usdVal / btcRate) * 100_000_000);
      return isBtc
        ? (estSats / 100_000_000).toFixed(8).replace(/\.?0+$/, "")
        : String(estSats);
    }
    // LBTC → USDt: convert sats to USD
    if (sendId === policyHex && recvIsUsd) {
      const usdVal = lbtcToUsd(enteredUnits);
      if (usdVal == null) return "";
      const dp = recvPrecision != null && recvPrecision <= 2 ? recvPrecision : 2;
      return usdVal.toFixed(dp);
    }
    return "";
  })();

  /** Balance display in the correct denomination for LBTC, or asset precision otherwise. */
  const balanceDisplay = sendId === policyHex
    ? `${fmtLbtc(sendBalance)} ${sendLabel}`
    : `${formatAssetAmount(sendBalance, sendPrecision)} ${sendLabel}`;

  function onSendAssetChange(id: string) {
    setSendAssetId(id);
    setRecvAssetId(""); // reset so the auto-default picks the other asset
    setAmount("");
    setRecvInput("");
    setQuote(null);
    setError("");
  }

  function onRecvAssetChange(id: string) {
    setRecvAssetId(id);
    setRecvInput("");
    setQuote(null);
    setError("");
  }

  /** Send-amount input handler — also forward-computes the USD receive estimate
   *  when receiving a USD-pegged asset. Clears any explicit receive input since
   *  the user is now specifying the send side. */
  function onSendAmountChange(val: string) {
    setAmount(val);
    setRecvInput(""); // user is driving from the send side
    setQuote(null); // clear stale quote so estimates recompute
  }

  /** Receive-amount (USD) input handler — in receive-exact mode the dealer
   *  determines how much to charge, so we clear the send-side input. */
  function onRecvAmountChange(val: string) {
    setRecvInput(val);
    setAmount(""); // user is driving from the receive side
    setQuote(null);
  }

  /** Swap the send and receive assets (direction toggle). */
  function flipDirection() {
    const prevSend = sendId;
    const prevRecv = recvId;
    setSendAssetId(prevRecv);
    setRecvAssetId(prevSend);
    setAmount("");
    setRecvInput("");
    setQuote(null);
    setError("");
  }

  function setMax() {
    setError("");
    if (sendId === policyHex) {
      // No fee reserve needed — the dealer builds the PSET so the Liquid
      // network fee comes out of the user's LBTC input. The verification
      // gate's maxFee cap (1000 sats) bounds it. Same UX as SideSwap's app.
      if (isBtc) {
        const btc = (sendBalance / 100_000_000).toFixed(8).replace(/\.?0+$/, "");
        onSendAmountChange(btc || "0");
      } else {
        onSendAmountChange(String(sendBalance));
      }
    } else {
      const prec = sendPrecision ?? 0;
      const p = prec > 0 ? prec : 0;
      if (p === 0) {
        onSendAmountChange(String(sendBalance));
      } else {
        const s = String(sendBalance).padStart(p + 1, "0");
        const whole = s.slice(0, -p);
        const frac = s.slice(-p).replace(/0+$/, "");
        onSendAmountChange(frac ? `${whole}.${frac}` : whole);
      }
    }
  }

  /** True when the user typed a receive amount (receive-exact mode). */
  const isReceiveExact = recvIsUsd && recvInput !== "" && Number(recvInput) > 0;

  /** Parse the receive input into base units of the receive asset. */
  const recvUnits = (() => {
    if (!isReceiveExact) return 0;
    const prec = recvPrecision ?? 8;
    return parseAssetAmount(recvInput, prec) ?? 0;
  })();

  /** Estimated send amount as a display string for the send input,
   *  computed from the BTC/USD rate when the user is driving from the receive
   *  side. Only populated when the receive input has a value. */
  const estSendDisplay = (() => {
    if (quote) return "";
    const rv = recvInput !== "" ? Number(recvInput) : 0;
    if (rv <= 0 || !btcRate) return "";
    // Parse receive input into base units for the estimate
    const rPrec = recvPrecision ?? 8;
    const rUnits = parseAssetAmount(recvInput, rPrec) ?? 0;
    if (rUnits <= 0) return "";
    // Receiving USDt, sending LBTC: convert USDt amount to estimated LBTC
    if (recvIsUsd && sendId === policyHex) {
      const usdVal = rUnits / 10 ** rPrec;
      const estSats = Math.round((usdVal / btcRate) * 100_000_000);
      return isBtc
        ? (estSats / 100_000_000).toFixed(8).replace(/\.?0+$/, "")
        : String(estSats);
    }
    // Receiving LBTC, sending USDt: convert LBTC amount to estimated USDt
    if (recvId === policyHex && sendIsUsd) {
      const estUsd = lbtcToUsd(rUnits);
      if (estUsd == null) return "";
      const dp = sendPrecision != null && sendPrecision <= 2 ? sendPrecision : 2;
      return estUsd.toFixed(dp);
    }
    return "";
  })();

  /** Fetch the dealer quote preview for the current form values. Surfaces a
   *  retryable failure on the review screen rather than stranding the user on
   *  a disabled "Waiting for quote…" button when the dealer is unreachable. */
  async function fetchQuote() {
    setBusy(true);
    setQuoteError(false);
    setError(""); // clear any prior execution error so the re-quote branch unlatches
    setAvailableUnits(null);
    setQuote(null);
    try {
      const opts = isReceiveExact
        ? { recvAmount: recvUnits }
        : { sendAmount: enteredUnits };
      const q = await wallet.swapQuote(sendId, recvId, opts);
      setQuote(q);
    } catch {
      setQuoteError(true);
    } finally {
      setBusy(false);
    }
  }

  async function review() {
    setError("");
    if (!recvId) return setError("Select an asset to receive.");
    if (sendId === recvId) return setError("Select two different assets to swap.");
    if (isReceiveExact) {
      if (recvUnits <= 0) return setError("Enter a receive amount.");
    } else {
      if (enteredUnits <= 0) return setError(`Enter an amount in ${sendUnitLabel}.`);
      if (enteredUnits > sendBalance) return setError("Amount exceeds your available balance.");
    }
    setStep("review");
    await fetchQuote();
  }

  async function executeSwap() {
    setError("");
    if (requiresPasswordLocally && !password) return setError("Enter your password to swap.");
    // Never submit against a lapsed quote — taker_sign would reject the dead
    // quote_id anyway, and the attempt would consume a password step-up.
    if (quoteExpired) return setError("This quote expired. Get a fresh quote to continue.");
    setBusy(true);
    setStep("swapping");
    try {
      const opts: Parameters<typeof wallet.swap>[2] = isReceiveExact
        ? { recvAmount: recvUnits }
        : { sendAmount: enteredUnits };
      // Thread the user-reviewed quote amounts into the swap call so the
      // verification gate can enforce them independently of the dealer's
      // execution-time quote. Without this, a malicious dealer could
      // inflate the send amount (receive-exact) or degrade the receive
      // amount (sell-exact) between review and execution.
      if (quote) {
        opts.reviewedSendAmount = quote.sendAmount;
        opts.reviewedRecvAmount = quote.recvAmount;
      }
      // Send whatever the user typed. Keyed on `password` rather than the advisory
      // `needsPassword` so a step-up the panel didn't predict (stale/failed
      // getAutoLock) still gets satisfied; the SW ignores it when not required.
      if (password) opts.password = password;
      const res = await wallet.swap(sendId, recvId, opts);
      setResult(res);
      setStep("done");
    } catch (e) {
      setError(swapErrorMessage(e));
      setStep("review");
      // Only an auth failure leaves the reviewed quote trustworthy — the swap
      // terms never changed, the user just needs to re-enter their password. For
      // anything else (gate rejection, dealer re-quote, unknown) the amounts the
      // user approved may no longer hold, so DROP the quote: `reviewedSendAmount`
      // / `reviewedRecvAmount` are the independent caps the gate enforces, and
      // re-sending stale ones would re-arm Confirm against terms the dealer has
      // already moved away from. Clearing forces a fresh quote first.
      if (swapErrorKind(e) !== "auth") {
        setQuote(null);
        setPassword("");
      }
      // Dealer told us how much it can actually fill — keep it for the hint.
      setAvailableUnits(lowBalanceAvailable(e));
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
              {sendId === policyHex ? fmtLbtc(Number(result.sent)) : formatAssetAmount(Number(result.sent), sendPrecision)} {sendId === policyHex ? (isBtc ? "LBTC" : "sats") : sendLabel}{" → "}
              {recvId === policyHex ? fmtLbtc(Number(result.received)) : formatAssetAmount(Number(result.received), recvPrecision)} {recvId === policyHex ? (isBtc ? "LBTC" : "sats") : recvLabel}
            </p>
            {(() => {
              const sentUsd = sendId === policyHex
                ? lbtcToUsd(Number(result.sent))
                : sendIsUsd ? Number(result.sent) / 10 ** (sendPrecision ?? 8) : null;
              const rcvdUsd = recvIsUsd
                ? Number(result.received) / 10 ** (recvPrecision ?? 8)
                : recvId === policyHex ? lbtcToUsd(Number(result.received)) : null;
              if (sentUsd === null && rcvdUsd === null) return null;
              return (
                <p className="text-xs text-[color:var(--text-subtle)]">
                  {sentUsd !== null && `≈ ${fmtUsd(sentUsd)}`}
                  {sentUsd !== null && rcvdUsd !== null && " → "}
                  {rcvdUsd !== null && `≈ ${fmtUsd(rcvdUsd)}`}
                </p>
              );
            })()}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--surface-soft)] px-3 py-2">
          <span className="text-xs text-[color:var(--text-secondary)]">
            {Number(result.fee) > 0
              ? `Network fee: ${formatSats(Number(result.fee))} sats`
              : "Network fee included in receive amount"}
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
    // In receive-exact mode, the user specified the receive amount and the
    // dealer determines the send amount. In sell-exact mode, the reverse.
    const recvUnitLabel = recvId === policyHex
      ? isBtc ? "LBTC" : "sats"
      : recvLabel;
    const payDisplay = isReceiveExact
      ? (quote ? `${sendId === policyHex ? fmtLbtc(Number(quote.sendAmount)) : formatAssetAmount(Number(quote.sendAmount), sendPrecision)} ${sendUnitLabel}` : null)
      : `${sendId === policyHex ? fmtLbtc(enteredUnits) : formatAssetAmount(enteredUnits, sendPrecision)} ${sendUnitLabel}`;
    const recvDisplay = isReceiveExact
      ? `${recvId === policyHex ? fmtLbtc(recvUnits) : formatAssetAmount(recvUnits, recvPrecision)} ${recvUnitLabel}`
      : (quote ? `${recvId === policyHex ? fmtLbtc(Number(quote.recvAmount)) : formatAssetAmount(Number(quote.recvAmount), recvPrecision)} ${recvUnitLabel}` : null);

    return (
      <Card>
        <h2 className="mb-3 text-center console-overline console-ruled--center">
          Review Swap
        </h2>
        <dl className="flex flex-col gap-0 text-sm">
          {/* Send side */}
          <div className="flex items-center justify-between gap-3 border-b border-[color:var(--border-soft)] px-1 py-2">
            <dt className="text-[color:var(--text-subtle)]">From</dt>
            <dd className="text-[color:var(--text-primary)]">{sendLabel}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 border-b border-[color:var(--border-soft)] px-1 py-2">
            <dt className="text-[color:var(--text-subtle)]">
              You pay{isReceiveExact && !quote ? " (est.)" : ""}
            </dt>
            <dd className="console-value text-[color:var(--text-primary)]">
              {payDisplay ?? (busy ? "Fetching..." : "\u2014")}
            </dd>
          </div>
          {/* Receive side */}
          <div className="flex items-center justify-between gap-3 border-b border-[color:var(--border-soft)] px-1 py-2">
            <dt className="text-[color:var(--text-subtle)]">To</dt>
            <dd className="text-[color:var(--text-primary)]">{recvLabel}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 border-b border-[color:var(--border-soft)] px-1 py-2">
            <dt className="text-[color:var(--text-subtle)]">
              You receive{!isReceiveExact && !quote ? " (est.)" : ""}
            </dt>
            <dd className="console-value text-[color:var(--text-primary)]">
              {recvDisplay ?? (busy ? "Fetching..." : "\u2014")}
            </dd>
          </div>
          {/* Fee */}
          <div className="flex items-center justify-between gap-3 border-b border-[color:var(--border-soft)] px-1 py-2">
            <dt className="text-[color:var(--text-subtle)]">Network fee</dt>
            <dd className="text-[color:var(--text-secondary)]">Up to {formatSats(SWAP_MAX_FEE_SATS)} sats</dd>
          </div>
          {/* Quote expiry — the dealer only honors a live quote_id. */}
          {quote && secsLeft !== null && (
            <div className="flex items-center justify-between gap-3 border-b border-[color:var(--border-soft)] px-1 py-2">
              <dt className="text-[color:var(--text-subtle)]">Quote expires</dt>
              <dd
                className={
                  quoteExpired
                    ? "text-[color:var(--danger-text,var(--text-primary))]"
                    : "console-value text-[color:var(--text-secondary)]"
                }
              >
                {quoteExpired
                  ? "Expired"
                  : `in ${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, "0")}`}
              </dd>
            </div>
          )}
        </dl>
        <p className="mt-3 text-xs text-[color:var(--text-subtle)]">
          The swap is verified independently before signing. If the rate moved
          unfavorably, it will not sign.
        </p>
        {/* Re-quote path: either the preview failed outright (quoteError), or a
            failed execution dropped a no-longer-trustworthy quote. Both need a
            fresh quote before Confirm can arm again \u2014 never a stale one. */}
        {quoteError || (!quote && !busy && error) ? (
          <div className="mt-3 flex flex-col gap-2">
            <ErrorText>
              {error || "Couldn't get a quote \u2014 the dealer may be unavailable. Try again."}
            </ErrorText>
            {/* The dealer's own fillable figure, so "too big" becomes actionable. */}
            {availableUnits !== null && availableUnits > 0n && (
              <p className="text-xs text-[color:var(--text-subtle)]">
                The dealer can currently fill up to{" "}
                {sendId === policyHex
                  ? `${fmtLbtc(Number(availableUnits))} ${isBtc ? "LBTC" : "sats"}`
                  : `${formatAssetAmount(Number(availableUnits), sendPrecision)} ${sendLabel}`}
                .
              </p>
            )}
            <Button variant="secondary" onClick={fetchQuote} disabled={busy}>
              {busy ? <Spinner /> : "Get a fresh quote"}
            </Button>
            <Button variant="secondary" onClick={() => setStep("form")} disabled={busy}>
              Back
            </Button>
          </div>
        ) : (
          <>
            {needsPassword && (
              <Field label="Password">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Re-enter to confirm"
                />
              </Field>
            )}
            <ErrorText>{error}</ErrorText>
            <div className="mt-3 flex flex-col gap-2">
              {quoteExpired ? (
                <Button variant="secondary" onClick={fetchQuote} disabled={busy}>
                  {busy ? <Spinner /> : "Get a fresh quote"}
                </Button>
              ) : (
                <Button
                  onClick={executeSwap}
                  disabled={busy || !quote || (needsPassword && !password)}
                >
                  {busy ? <Spinner /> : quote ? "Confirm swap" : "Waiting for quote\u2026"}
                </Button>
              )}
              <Button variant="secondary" onClick={() => setStep("form")} disabled={busy}>
                Back
              </Button>
            </div>
          </>
        )}
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
            {sendId === policyHex ? (
              <button
                type="button"
                onClick={() => {
                  const nextIsBtc = !isBtc;
                  const n = Number(amount);
                  if (Number.isFinite(n) && n > 0) {
                    setAmount(nextIsBtc
                      ? (n / 100_000_000).toFixed(8).replace(/\.?0+$/, "")
                      : String(Math.round(n * 100_000_000)));
                  }
                  setLocalUnit(nextIsBtc ? "btc" : "sats");
                }}
                className="text-xs font-medium text-[color:var(--text-secondary)] hover:text-[color:var(--accent)]"
                title="Toggle denomination"
              >
                Amount ({sendUnitLabel})
              </button>
            ) : (
              <span className="text-xs font-medium text-[color:var(--text-secondary)]">
                Amount ({sendUnitLabel})
              </span>
            )}
            <div className="flex items-center gap-2">
              <span className="text-xs text-[color:var(--text-subtle)]">
                Balance: {balanceDisplay}
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
            className={`console-value text-[15px] ${!amount && estSendDisplay ? "text-[color:var(--text-subtle)]" : ""}`}
            type="text"
            inputMode="decimal"
            value={amount || estSendDisplay}
            onChange={(e) => onSendAmountChange(e.target.value)}
            placeholder={
              sendId === policyHex
                ? isBtc
                  ? "0.00000000"
                  : "0"
                : sendPrecision && sendPrecision > 0
                  ? `0.${"0".repeat(Math.min(sendPrecision, 2))}`
                  : "0"
            }
          />
          {sendUsd !== null && (
            <span className="text-xs text-[color:var(--text-subtle)]">
              ≈ {fmtUsd(sendUsd)}
            </span>
          )}
        </div>

        {/* Direction toggle — swaps send and receive assets */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={flipDirection}
            className="flex size-8 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:var(--surface-soft)] text-[color:var(--text-secondary)] transition-colors hover:border-[color:var(--accent)] hover:text-[color:var(--accent)]"
            title="Swap direction"
          >
            <ArrowDown size={16} />
          </button>
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
        {/* Receive amount — always shown. Editable for USD-pegged receive
            assets (receive-exact mode); read-only estimate otherwise. When the
            user types a send amount, this shows the estimated receive amount
            directly in the input so both fields update in real time. */}
        {recvId && (
          <div className="-mt-1.5 flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[color:var(--text-secondary)]">
              Amount ({recvLabel})
            </span>
            <Input
              className={`console-value text-[15px] ${!recvInput && estRecvDisplay ? "text-[color:var(--text-subtle)]" : ""}`}
              type="text"
              inputMode="decimal"
              value={recvInput || estRecvDisplay}
              onChange={recvIsUsd ? (e) => onRecvAmountChange(e.target.value) : undefined}
              readOnly={!recvIsUsd}
              placeholder={
                recvId === policyHex
                  ? isBtc
                    ? "0.00000000"
                    : "0"
                  : recvPrecision && recvPrecision > 0
                    ? `0.${"0".repeat(Math.min(recvPrecision, 2))}`
                    : "0"
              }
            />
            {recvInput && recvIsUsd && (
              <span className="text-xs text-[color:var(--text-subtle)]">
                The dealer calculates how much {sendLabel} to charge.
              </span>
            )}
          </div>
        )}

        <ErrorText>{error}</ErrorText>
        <Button onClick={review} disabled={busy}>
          {busy ? <Spinner /> : "Review"}
        </Button>
      </div>
    </Card>
  );
}
