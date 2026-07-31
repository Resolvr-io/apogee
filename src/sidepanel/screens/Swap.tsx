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
import {
  Button,
  Card,
  CopyButton,
  ErrorText,
  Field,
  Input,
  Spinner,
  TelemetryNumber,
} from "@/sidepanel/components/ui";
import { AssetSelect } from "@/sidepanel/components/AssetSelect";
import {
  lowBalanceAvailable,
  swapErrorKind,
  swapErrorMessage,
  wallet,
} from "@/sidepanel/wallet-client";
import { SWAP_MAX_FEE_SATS, SWAP_TYPICAL_FEE_SATS } from "@/sideswap/constants";
import { estimateSendUnitsNeeded, FEE_ALLOWANCE_SATS } from "@/sideswap/affordability";

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

  // ---- cost disclosure -------------------------------------------------------
  //
  // SideSwap's own app quotes ALL-IN (it asks for ~1638 sats to deliver $1, where
  // the naive market rate is ~1552). We quote notional and the costs land as a
  // smaller receive, so the same swap looks like a shortfall. Measured on a real
  // $1 swap: 1550 sats offered → 0.943 USDt, i.e. a 60-sat network fee plus a
  // ~26-sat dealer fee — 86 sats, exactly SideSwap's 86-sat premium. Same
  // economics, so the fix is disclosure, not arithmetic.
  const dealerFeeSats =
    quote == null ? null : Number(BigInt(quote.fixedFee) + BigInt(quote.serverFee));
  /** Dealer + network, the single figure the user cares about. */
  const totalCostSats =
    dealerFeeSats == null ? null : dealerFeeSats + SWAP_TYPICAL_FEE_SATS;

  // ---- pre-quote affordability ----------------------------------------------
  //
  // Both fees are L-BTC-denominated and flat. Measured live: ~83 sats dealer +
  // ~60 sats network. Used to catch an underfunded swap BEFORE asking the dealer,
  // since a refusal surfaces as "the dealer may be unavailable" and looks broken.
  // Deliberately an over-estimate: a false "reduce the amount" is recoverable, a
  // false green light ends in a confusing dealer error.
  const feeAllowanceSats = FEE_ALLOWANCE_SATS;
  /** Total cost (dealer + network) as a percentage of the L-BTC side of the swap.
   *  Both fees are L-BTC-denominated, so the L-BTC leg is the honest denominator
   *  whichever direction the swap runs. */
  const costPct = (() => {
    if (dealerFeeSats == null || totalCostSats == null || quote == null) return null;
    // Denominator is the swap's PRINCIPAL, excluding fees. `quote.sendAmount` is
    // now fee-inclusive (see previewSwapQuote), so net the dealer fee back out on
    // an L-BTC send; the receive leg never included it.
    const principal =
      sendId === policyHex
        ? Number(quote.sendAmount) - dealerFeeSats
        : Number(quote.recvAmount);
    if (!Number.isFinite(principal) || principal <= 0) return null;
    // Use the TYPICAL fee, not the cap: the exact fee isn't known until the
    // dealer builds the PSET, but two mainnet swaps measured 53-60 sats. Using
    // the 1000-sat ceiling here would report ~66% on a $1 swap whose real cost
    // was ~9% — alarming and wrong. The cap still governs verification.
    return (totalCostSats / principal) * 100;
  })();

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
      // Round DOWN, never to nearest: this is a market-rate figure that excludes
      // the dealer spread and the network fee, so it is already optimistic.
      // `toFixed` would round 0.9988 up to a flattering "1.00" and then the swap
      // delivers ~0.94 — measured on a real $1 swap — which reads as a shortfall.
      const f = 10 ** dp;
      return (Math.floor(usdVal * f) / f).toFixed(dp);
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
      // Reserve the fees. The network fee AND the dealer's fee both come out of the
      // user's own L-BTC on a policy-asset send, so filling the entire balance
      // leaves nothing to pay them with — the dealer then can't build a valid PSET
      // and refuses, which surfaced as a misleading "dealer may be unavailable".
      const spendable = Math.max(0, sendBalance - feeAllowanceSats);
      if (isBtc) {
        const btc = (spendable / 100_000_000).toFixed(8).replace(/\.?0+$/, "");
        onSendAmountChange(btc || "0");
      } else {
        onSendAmountChange(String(spendable));
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

  /** Send-side units a receive-exact swap will roughly cost, fees included — the
   *  affordability check `review()` runs before contacting the dealer. Null when it
   *  can't be estimated (no rate yet, or a pair we don't have a rate for), in which
   *  case the check is skipped rather than guessing: the dealer's own refusal is
   *  still the backstop, just a worse-worded one. */
  const estSendUnitsNeeded = estimateSendUnitsNeeded({
    recvUnits: isReceiveExact ? recvUnits : 0,
    recvPrecision: recvPrecision ?? 8,
    sendPrecision: sendPrecision ?? 8,
    recvIsUsdSendLbtc: recvIsUsd && sendId === policyHex,
    recvIsLbtcSendUsd: recvId === policyHex && sendIsUsd,
    btcRate,
  });

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
      // Receive-exact had NO balance check: the user types a receive amount and the
      // dealer derives the charge, so an underfunded wallet only found out when the
      // dealer refused — surfacing as "the dealer may be unavailable", which blames
      // the counterparty for the user's own shortfall and reads as a broken feature.
      // Estimate the charge from the market rate plus fees and catch it up front.
      if (estSendUnitsNeeded !== null && estSendUnitsNeeded > sendBalance) {
        return setError(
          `Not enough ${sendLabel} — about ${sendId === policyHex ? fmtLbtc(estSendUnitsNeeded) : formatAssetAmount(estSendUnitsNeeded, sendPrecision)} ${sendUnitLabel} needed, including fees.`,
        );
      }
    } else {
      if (enteredUnits <= 0) return setError(`Enter an amount in ${sendUnitLabel}.`);
      if (enteredUnits > sendBalance) return setError("Amount exceeds your available balance.");
      // Sell-exact checked the principal but not the fees on top. Sending an L-BTC
      // amount equal to the whole balance leaves nothing for the network fee, so the
      // dealer can't build a valid PSET — same misleading error. (Max deliberately
      // fills the full balance, so this is reachable by design.)
      if (sendId === policyHex && enteredUnits + feeAllowanceSats > sendBalance) {
        return setError(
          `Leave about ${fmtLbtc(feeAllowanceSats)} ${sendUnitLabel} for fees, or reduce the amount.`,
        );
      }
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
            {/* Two TelemetryNumbers, not one over the whole "A → B" string: it splits
                at the FIRST unit after the digits, so a single call would treat
                everything from "sats" onward — including the received amount's own
                figures — as one unit and set it all in the body face. */}
            <p className="text-sm text-[color:var(--text-secondary)]">
              <TelemetryNumber
                glow={false}
                value={`${sendId === policyHex ? fmtLbtc(Number(result.sent)) : formatAssetAmount(Number(result.sent), sendPrecision)} ${sendId === policyHex ? (isBtc ? "LBTC" : "sats") : sendLabel}`}
              />
              {" → "}
              <TelemetryNumber
                glow={false}
                value={`${recvId === policyHex ? fmtLbtc(Number(result.received)) : formatAssetAmount(Number(result.received), recvPrecision)} ${recvId === policyHex ? (isBtc ? "LBTC" : "sats") : recvLabel}`}
              />
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
    // Mirrors the orchestrator's sell-exact slippage floor: reviewedRecvAmount *
    // 97/100 (see `defaultMinRecv`). Kept as integer math on the same base units
    // so the number shown is exactly the bound the gate enforces, not an
    // approximation of it. Only meaningful once the dealer's quote has arrived.
    const minRecvDisplay = (() => {
      if (isReceiveExact || !quote) return null;
      const floor = (BigInt(quote.recvAmount) * 97n) / 100n;
      const n = Number(floor);
      return `${recvId === policyHex ? fmtLbtc(n) : formatAssetAmount(n, recvPrecision)} ${recvUnitLabel}`;
    })();
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
            {/* TelemetryNumber only when there IS an amount: it treats a letter run
                with no digits after it as a currency prefix, so "Fetching..." would
                come out small and raised. The placeholders stay body text. */}
            <dd className="text-[color:var(--text-primary)]">
              {payDisplay ? (
                <TelemetryNumber value={payDisplay} glow={false} />
              ) : busy ? (
                "Fetching..."
              ) : (
                "\u2014"
              )}
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
            <dd className="text-[color:var(--text-primary)]">
              {recvDisplay ? (
                <TelemetryNumber value={recvDisplay} glow={false} />
              ) : busy ? (
                "Fetching..."
              ) : (
                "\u2014"
              )}
            </dd>
          </div>
          {/* Fees: one calm line, with the split available on demand via the
              existing `.drawer` <details> pattern. Previously this was three rows
              plus a red percentage and a red warning paragraph, which read as an
              error state for what is a normal, correctly-quoted swap. */}
          {totalCostSats !== null && (
            <div className="flex items-center justify-between gap-3 border-b border-[color:var(--border-soft)] px-1 py-2">
              <dt className="text-[color:var(--text-subtle)]">Fees</dt>
              <dd className="text-[color:var(--text-secondary)]">
                ≈ {formatSats(totalCostSats)} sats
                {(() => {
                  const usd = lbtcToUsd(totalCostSats);
                  return usd != null ? ` (${fmtUsd(usd)})` : "";
                })()}
                {costPct !== null && (
                  <span className="text-[color:var(--text-subtle)]">
                    {" · "}
                    {costPct < 0.1 ? "<0.1" : costPct.toFixed(1)}%
                  </span>
                )}
              </dd>
            </div>
          )}
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
        {/* One muted line, expandable. Constraint #4 wants the trust model
            surfaced, not a paragraph on the confirm screen — the summary names the
            counterparty, the body carries the detail for whoever wants it. Fee
            arithmetic lives here too, so a small swap's percentage is explained on
            demand rather than shouted in red. */}
        <details className="drawer mt-3">
          <summary className="cursor-pointer px-1 py-1.5 text-xs text-[color:var(--text-subtle)]">
            Quoted by SideSwap · atomic swap, funds never held
          </summary>
          <div className="flex flex-col gap-1.5 px-1 pb-1.5 text-xs text-[color:var(--text-subtle)]">
            {dealerFeeSats !== null && dealerFeeSats > 0 && (
              <p>
                Fees: {formatSats(dealerFeeSats)} sats to the dealer, ≈{" "}
                {formatSats(SWAP_TYPICAL_FEE_SATS)} sats network (max{" "}
                {formatSats(SWAP_MAX_FEE_SATS)}). These are mostly flat, so they're a
                bigger share of a small swap.
              </p>
            )}
            {minRecvDisplay && <p>You'll receive at least {minRecvDisplay}.</p>}
            <p>
              SideSwap quotes the price and broadcasts. Both sides move in one Liquid
              transaction, so your funds are never held by anyone. Apogee checks the
              amounts before signing and won't sign if they moved against you.
            </p>
          </div>
        </details>
        {/* Re-quote path: either the preview failed outright (quoteError), or a
            failed execution dropped a no-longer-trustworthy quote. Both need a
            fresh quote before Confirm can arm again \u2014 never a stale one. */}
        {quoteError || (!quote && !busy && error) ? (
          <div className="mt-3 flex flex-col gap-2">
            <ErrorText>
              {error ||
                // Don't blame the dealer when the likely cause is a thin balance:
                // a quote request for more than the wallet can cover is refused, and
                // "the dealer may be unavailable" sends the user chasing the wrong
                // problem. The pre-quote check catches most of these, so this is the
                // fallback for cases it couldn't estimate.
                (sendId === policyHex && sendBalance <= feeAllowanceSats
                  ? `Not enough ${sendLabel} to cover a swap plus fees.`
                  : "Couldn't get a quote. The dealer may be unavailable, or the amount may be outside what it will fill right now.")}
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
        <div className="flex flex-col gap-2">
          <Button onClick={review} disabled={busy}>
            {busy ? <Spinner /> : "Review"}
          </Button>
          {/* Matches Send and Receive: an easy exit from the form step without
              hunting for the small top-left back arrow. `onDone` is the caller's
              leave-the-flow handler (it clears the pending asset and returns home);
              nothing has been swapped, so there's nothing extra to undo. */}
          <Button variant="secondary" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}
