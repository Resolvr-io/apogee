// Pre-quote affordability estimate for a receive-exact swap.
//
// Receive-exact had no balance check at all: the user names the amount they want to
// RECEIVE and the dealer derives the charge, so an underfunded wallet only found out
// when the dealer refused — surfacing as "the dealer may be unavailable", which
// blames the counterparty for the user's own shortfall and reads as a broken feature.
//
// This estimates the send side from the market rate plus a flat fee allowance so the
// form can refuse early with an actionable message. Extracted from Swap.tsx so the
// arithmetic is unit-testable (the component needs a DOM).
//
// Deliberately an OVER-estimate: a false "reduce the amount" is recoverable, whereas a
// false green light ends in the confusing dealer error this exists to prevent. It is
// NOT a safety boundary — the verification gate still bounds the real outflow.

/** Flat fee allowance in sats. Measured mainnet swaps: ~83 sats dealer + ~53-60 sats
 *  network. Rounded up, since over-estimating is the safe direction. */
export const FEE_ALLOWANCE_SATS = 160;

export interface AffordabilityInput {
  /** Base units of the asset the user wants to receive. */
  recvUnits: number;
  /** Decimals of the receive asset (8 for L-BTC and USDt). */
  recvPrecision: number;
  /** Decimals of the send asset. */
  sendPrecision: number;
  /** True when receiving a USD-pegged asset and sending L-BTC. */
  recvIsUsdSendLbtc: boolean;
  /** True when receiving L-BTC and sending a USD-pegged asset. */
  recvIsLbtcSendUsd: boolean;
  /** BTC/USD rate, or null when not yet loaded. */
  btcRate: number | null;
}

/** Send-side base units a receive-exact swap will roughly cost, fees included.
 *
 *  Returns null when it can't be estimated — no rate yet, or a pair we don't price.
 *  The caller must SKIP the check on null rather than blocking: the dealer's refusal
 *  remains the backstop, just with worse wording. */
export function estimateSendUnitsNeeded(i: AffordabilityInput): number | null {
  if (i.recvUnits <= 0) return null;

  // Sending L-BTC: fees are L-BTC-denominated, so they add directly to the sats needed.
  if (i.recvIsUsdSendLbtc) {
    if (!i.btcRate) return null;
    const usd = i.recvUnits / 10 ** i.recvPrecision;
    return Math.round((usd / i.btcRate) * 100_000_000) + FEE_ALLOWANCE_SATS;
  }

  // Sending USDt for L-BTC. The allowance still applies, converted to USDt. On a
  // SELL-exact USDt swap the dealer absorbs the L-BTC fee by delivering less L-BTC —
  // but here the receive amount is fixed by the user, so it can't absorb anything:
  // the dealer charges more USDt instead. Omitting this margin let a USDt balance
  // just above market value pass and then hit the dealer refusal.
  if (i.recvIsLbtcSendUsd) {
    if (!i.btcRate) return null;
    const usd = (i.recvUnits / 100_000_000) * i.btcRate;
    const feeUsd = (FEE_ALLOWANCE_SATS / 100_000_000) * i.btcRate;
    return Math.round((usd + feeUsd) * 10 ** i.sendPrecision);
  }

  return null;
}
