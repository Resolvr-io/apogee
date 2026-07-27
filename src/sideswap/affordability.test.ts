// Tests for the pre-quote affordability estimate.
//
// The property that matters is DIRECTIONAL: this estimate must never under-state what a
// swap costs. Under-stating produces a false green light, and the user then hits the
// dealer's refusal rendered as "the dealer may be unavailable" — the exact confusing
// outcome the guard exists to prevent. Over-stating merely says "reduce the amount",
// which is recoverable.

import { describe, expect, it } from "vitest";
import { estimateSendUnitsNeeded, FEE_ALLOWANCE_SATS } from "./affordability";

const RATE = 64_500; // BTC/USD

/** Receiving USDt, sending L-BTC — the case that motivated the guard. */
function lbtcSend(usd: number, btcRate: number | null = RATE) {
  return estimateSendUnitsNeeded({
    recvUnits: Math.round(usd * 1e8), // USDt has 8 decimals
    recvPrecision: 8,
    sendPrecision: 8,
    recvIsUsdSendLbtc: true,
    recvIsLbtcSendUsd: false,
    btcRate,
  });
}

/** Receiving L-BTC, sending USDt. */
function usdtSend(sats: number, btcRate: number | null = RATE) {
  return estimateSendUnitsNeeded({
    recvUnits: sats,
    recvPrecision: 8,
    sendPrecision: 8,
    recvIsUsdSendLbtc: false,
    recvIsLbtcSendUsd: true,
    btcRate,
  });
}

describe("estimateSendUnitsNeeded — L-BTC send", () => {
  it("covers the market notional plus the fee allowance", () => {
    // $1 at 64500 is ~1550 sats; the estimate must exceed that by the allowance.
    const notional = Math.round((1 / RATE) * 1e8);
    expect(lbtcSend(1)).toBe(notional + FEE_ALLOWANCE_SATS);
  });

  it("never under-states — the allowance exceeds real measured fees", () => {
    // Mainnet: ~83 sats dealer + ~53-60 network = ~143. The allowance must cover it,
    // or the guard green-lights a swap the dealer will refuse.
    expect(FEE_ALLOWANCE_SATS).toBeGreaterThan(83 + 60);
  });

  it("scales the notional with size but keeps the allowance flat", () => {
    // Flat fees are why a small swap costs a large percentage; the estimate must model
    // that rather than scaling the fee.
    const one = lbtcSend(1)!;
    const twenty = lbtcSend(20)!;
    // Notional scales ~20x (within rounding — each Math.round contributes up to a
    // sat, so a 20x scale-up drifts by a handful).
    expect(twenty - FEE_ALLOWANCE_SATS).toBeGreaterThan((one - FEE_ALLOWANCE_SATS) * 20 - 25);
    expect(twenty - FEE_ALLOWANCE_SATS).toBeLessThan((one - FEE_ALLOWANCE_SATS) * 20 + 25);
    // The allowance itself does NOT scale — that is the whole point.
    expect(twenty - (one - FEE_ALLOWANCE_SATS) * 20).toBeCloseTo(FEE_ALLOWANCE_SATS, -2);
  });

  it("returns null without a rate, so the caller skips rather than blocks", () => {
    expect(lbtcSend(1, null)).toBeNull();
  });
});

describe("estimateSendUnitsNeeded — USDt send", () => {
  it("adds a rate-converted allowance, not zero", () => {
    // Regression: this branch originally carried NO margin, on the incorrect reasoning
    // that the dealer absorbs the L-BTC fee. In receive-exact the L-BTC receive is
    // FIXED, so the dealer charges more USDt instead — a USDt balance just above market
    // value would pass and then hit the dealer refusal.
    const sats = 31_000;
    const marketOnly = Math.round((sats / 1e8) * RATE * 1e8);
    const withMargin = usdtSend(sats)!;
    expect(withMargin).toBeGreaterThan(marketOnly);
  });

  it("returns null without a rate", () => {
    expect(usdtSend(31_000, null)).toBeNull();
  });
});

describe("estimateSendUnitsNeeded — guards", () => {
  it("returns null for a non-positive receive amount", () => {
    expect(lbtcSend(0)).toBeNull();
    expect(usdtSend(0)).toBeNull();
  });

  it("returns null for a pair it can't price", () => {
    // Neither flag set — e.g. a token pair with no USD peg. Must skip, not guess.
    expect(
      estimateSendUnitsNeeded({
        recvUnits: 1000,
        recvPrecision: 8,
        sendPrecision: 8,
        recvIsUsdSendLbtc: false,
        recvIsLbtcSendUsd: false,
        btcRate: RATE,
      }),
    ).toBeNull();
  });
});
