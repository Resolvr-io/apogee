// Unit tests for the dealer-PSET verification gate.
//
// verifyDealerPset is the last line of defense before signing: it ensures the
// PSET the dealer built matches the accepted quote terms. These tests exercise
// every security check — fair receive, send-asset drain, third-asset drain,
// fee cap — plus the happy path and edge cases (tolerance, zero-fee direction).
//
// lwk_wasm types are mocked: we construct fake balance maps that simulate what
// Wollet.psetDetails().balance() would return for various attack scenarios.

import { describe, it, expect, vi } from "vitest";
import {
  verifyDealerPset,
  type VerifyDealerPsetTerms,
} from "./verify-dealer-pset";

// ---- Mock helpers -----------------------------------------------------------

/** Build a mock Pset + Wollet pair that returns the given balance/fee maps.
 *  The maps mirror lwk_wasm's PsetBalance: balances are net per asset from the
 *  wallet's POV (negative = outflow, positive = inflow), fees are per asset. */
function mockPsetWollet(
  balances: Record<string, bigint>,
  fees: Record<string, bigint> = {},
) {
  const balanceMap = new Map(Object.entries(balances));
  const feeMap = new Map(Object.entries(fees));

  const balance = {
    balances: () => ({ entries: () => balanceMap }),
    fees: () => ({ entries: () => feeMap }),
  };

  const psetDetails = { balance: () => balance };

  const wollet = {
    psetDetails: vi.fn().mockReturnValue(psetDetails),
  };

  const pset = {
    addDetails: vi.fn(),
  };

  return { pset, wollet } as unknown as {
    pset: Parameters<typeof verifyDealerPset>[0];
    wollet: Parameters<typeof verifyDealerPset>[1];
  };
}

// ---- Test constants ---------------------------------------------------------

const LBTC = "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d";
const USDT = "ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2";
const OTHER = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function baseTerms(overrides?: Partial<VerifyDealerPsetTerms>): VerifyDealerPsetTerms {
  return {
    sendAssetId: LBTC,
    sendAmount: 100_000n,
    recvAssetId: USDT,
    minRecvAmount: 4_900_000_000n, // ~49 USDt at 8 decimals
    maxFee: 500n,
    ...overrides,
  };
}

// ---- Happy path -------------------------------------------------------------

describe("verifyDealerPset — happy path", () => {
  it("accepts a fair LBTC→USDt swap", () => {
    const terms = baseTerms();
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_000n, [USDT]: 5_000_000_000n },
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sent).toBe(100_000n);
      expect(result.received).toBe(5_000_000_000n);
      expect(result.fee).toBe(300n);
    }
  });

  it("accepts a fair USDt→LBTC swap (zero send-asset fee)", () => {
    const terms = baseTerms({
      sendAssetId: USDT,
      sendAmount: 5_000_000_000n,
      recvAssetId: LBTC,
      minRecvAmount: 95_000n,
      maxFee: 500n,
    });
    // When sending USDt, fee is in L-BTC (not send asset), so send-asset fee = 0.
    const { pset, wollet } = mockPsetWollet(
      { [USDT]: -5_000_000_000n, [LBTC]: 95_500n },
      {}, // no fee in send asset
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sent).toBe(5_000_000_000n);
      expect(result.received).toBe(95_500n);
      expect(result.fee).toBe(0n);
    }
  });

  it("calls addDetails before reading balances", () => {
    const terms = baseTerms();
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_000n, [USDT]: 5_000_000_000n },
      { [LBTC]: 300n },
    );

    verifyDealerPset(pset, wollet, terms);

    // addDetails must be called with the wollet so dealer PSETs get enriched
    expect(pset.addDetails).toHaveBeenCalledWith(wollet);
    // psetDetails must be called AFTER addDetails
    expect(wollet.psetDetails).toHaveBeenCalledWith(pset);
  });
});

// ---- Check 1: fair receive --------------------------------------------------

describe("verifyDealerPset — check 1: fair receive", () => {
  it("rejects when receive amount is below minimum", () => {
    const terms = baseTerms({ minRecvAmount: 5_000_000_000n });
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_000n, [USDT]: 4_999_999_999n }, // 1 sat short
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("receive");
      expect(result.reason).toContain("minimum");
    }
  });

  it("rejects when receive is zero (redirected output attack)", () => {
    // Dealer redirects receive output to their own address — wallet sees 0 inflow.
    const terms = baseTerms();
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_000n }, // no USDT entry at all
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("receive 0");
    }
  });

  it("accepts receive exactly at minimum", () => {
    const terms = baseTerms({ minRecvAmount: 5_000_000_000n });
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_000n, [USDT]: 5_000_000_000n },
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(true);
  });
});

// ---- Check 2: send-asset drain ----------------------------------------------

describe("verifyDealerPset — check 2: send-asset drain", () => {
  it("rejects when send outflow exceeds offered + fee + tolerance", () => {
    // Dealer inflates the send amount — taking more L-BTC than agreed.
    const terms = baseTerms({ sendAmount: 100_000n, maxFee: 500n });
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_502n, [USDT]: 5_000_000_000n }, // 100_502 > 100_000 + 300 + 1
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("spend");
      expect(result.reason).toContain("exceeds");
    }
  });

  it("accepts send at exactly offered + fee (within tolerance)", () => {
    const terms = baseTerms({ sendAmount: 100_000n, maxFee: 500n });
    // sent = 100_301 = sendAmount(100_000) + fee(300) + TOL(1) — right at boundary
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_301n, [USDT]: 5_000_000_000n },
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(true);
  });

  it("accepts when sent is less than offered (change returned)", () => {
    const terms = baseTerms({ sendAmount: 100_000n });
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -90_000n, [USDT]: 5_000_000_000n },
      { [LBTC]: 200n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(true);
  });
});

// ---- Check 2b: third-asset drain -------------------------------------------

describe("verifyDealerPset — check 2b: third-asset drain", () => {
  it("rejects when a third asset has negative net (drain attack)", () => {
    // Dealer folds in a UTXO of OTHER token owned by the wallet, paid to themselves.
    // Signer.sign signs every matching input regardless of asset.
    const terms = baseTerms();
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_000n, [USDT]: 5_000_000_000n, [OTHER]: -50_000n },
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unexpected outflow");
      expect(result.reason).toContain(OTHER);
    }
  });

  it("accepts when a third asset has zero net (self-spend, no drain)", () => {
    const terms = baseTerms();
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_000n, [USDT]: 5_000_000_000n, [OTHER]: 0n },
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(true);
  });

  it("accepts when a third asset has positive net (bonus inflow)", () => {
    const terms = baseTerms();
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_000n, [USDT]: 5_000_000_000n, [OTHER]: 1_000n },
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(true);
  });

  it("tolerates third-asset drain within 1-sat tolerance", () => {
    // -1n is within TOL (1n): net < -TOL means net < -1, so -1 passes.
    const terms = baseTerms();
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_000n, [USDT]: 5_000_000_000n, [OTHER]: -1n },
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(true);
  });

  it("rejects third-asset drain just past tolerance", () => {
    // -2n exceeds TOL: net(-2) < -TOL(-1) is true → reject.
    const terms = baseTerms();
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_000n, [USDT]: 5_000_000_000n, [OTHER]: -2n },
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unexpected outflow");
    }
  });
});

// ---- Check 3: fee cap -------------------------------------------------------

describe("verifyDealerPset — check 3: fee cap", () => {
  it("rejects when fee exceeds maxFee", () => {
    // sent(100_501) <= sendAmount(100_000) + fee(501) + TOL(1) → check 2 passes.
    // But fee(501) > maxFee(500) → check 3 rejects.
    const terms = baseTerms({ maxFee: 500n });
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_501n, [USDT]: 5_000_000_000n },
      { [LBTC]: 501n }, // 1 over cap
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("fee");
      expect(result.reason).toContain("exceeds cap");
    }
  });

  it("accepts fee exactly at maxFee", () => {
    const terms = baseTerms({ maxFee: 500n });
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_500n, [USDT]: 5_000_000_000n },
      { [LBTC]: 500n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(true);
  });

  it("accepts zero fee (USDt send direction)", () => {
    const terms = baseTerms({
      sendAssetId: USDT,
      sendAmount: 5_000_000_000n,
      recvAssetId: LBTC,
      minRecvAmount: 90_000n,
      maxFee: 500n,
    });
    const { pset, wollet } = mockPsetWollet(
      { [USDT]: -5_000_000_000n, [LBTC]: 95_000n },
      {}, // no fee in USDt — fee is in L-BTC, which is recv asset
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fee).toBe(0n);
    }
  });
});

// ---- Check 2a: maxSendAmount cap (receive-exact) ----------------------------

describe("verifyDealerPset — check 2a: maxSendAmount cap", () => {
  it("rejects when send exceeds maxSendAmount + fee + tolerance", () => {
    // Dealer quoted an inflated send amount that passes check 2 (matches its own
    // sendAmount) but exceeds the user-reviewed cap.
    const terms = baseTerms({
      sendAmount: 200_000n, // dealer's quote — high
      maxSendAmount: 100_000n, // user-reviewed cap — normal
    });
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -200_000n, [USDT]: 5_000_000_000n },
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("user-approved cap");
    }
  });

  it("accepts when send is within maxSendAmount + fee + tolerance", () => {
    const terms = baseTerms({
      sendAmount: 100_000n,
      maxSendAmount: 105_000n, // 5% headroom
    });
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_000n, [USDT]: 5_000_000_000n },
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(true);
  });

  it("accepts when send equals maxSendAmount + fee + TOL exactly", () => {
    const terms = baseTerms({
      sendAmount: 105_301n,
      maxSendAmount: 105_000n,
      maxFee: 500n,
    });
    // sent = 105_301 = maxSendAmount(105_000) + fee(300) + TOL(1)
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -105_301n, [USDT]: 5_000_000_000n },
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(true);
  });

  it("is a no-op when maxSendAmount is not set", () => {
    // Without maxSendAmount, only check 2 (sendAmount) applies.
    const terms = baseTerms({ sendAmount: 200_000n });
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -200_000n, [USDT]: 5_000_000_000n },
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(true);
  });
});

// ---- Combined attack scenarios ----------------------------------------------

describe("verifyDealerPset — combined attack scenarios", () => {
  it("rejects dealer that shorts receive AND inflates send", () => {
    const terms = baseTerms();
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -200_000n, [USDT]: 1_000_000_000n },
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(false);
    // Should fail on the first check hit (receive too low)
  });

  it("rejects dealer that meets receive but drains a third asset", () => {
    const terms = baseTerms();
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -100_000n, [USDT]: 5_000_000_000n, [OTHER]: -100_000n },
      { [LBTC]: 300n },
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unexpected outflow");
    }
  });

  it("rejects dealer with fair amounts but inflated fee", () => {
    const terms = baseTerms({ maxFee: 500n });
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -110_000n, [USDT]: 5_000_000_000n },
      { [LBTC]: 10_000n }, // absurd fee
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("fee");
    }
  });
});

// ---- Edge cases -------------------------------------------------------------

describe("verifyDealerPset — edge cases", () => {
  it("handles empty balance map (no wallet inputs recognized)", () => {
    // If addDetails fails silently, balances could be empty — everything is 0.
    const terms = baseTerms();
    const { pset, wollet } = mockPsetWollet({}, {});

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(false);
    // received = 0 < minRecvAmount → fail on check 1
    if (!result.ok) {
      expect(result.reason).toContain("receive 0");
    }
  });

  it("handles send asset with no balance entry (no outflow)", () => {
    // Only recv asset in balances — sent = 0, which is fine for check 2.
    const terms = baseTerms({ minRecvAmount: 0n });
    const { pset, wollet } = mockPsetWollet(
      { [USDT]: 5_000_000_000n },
      {},
    );

    const result = verifyDealerPset(pset, wollet, terms);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sent).toBe(0n);
    }
  });
});

// ---- receive-exact cap and the gate measure the SAME basis -------------------
//
// The soundness of check 2a rests on an invariant no other test covers:
// `maxSendAmount` (derived from the user-approved "You pay" figure) and the `sent`
// the gate measures from the PSET must be on the same *fee-inclusive* basis.
//
// It was broken. `previewSwapQuote` returned the dealer's `base_amount`, which
// EXCLUDES its L-BTC-denominated fee, so the cap was computed from a smaller number
// than the outflow the gate measures. Measured on mainnet: base 1556 + 83 dealer fee
// = 1639 actually paid, but the cap was 1556 * 105/100 = 1633 — BELOW the real
// charge, so the gate rejected a swap where nothing had drifted, reporting "the rate
// moved unfavorably". Numbers below are that real quote.
describe("verifyDealerPset — receive-exact cap on a fee-inclusive basis", () => {
  const BASE = 1556n; // dealer's base_amount (fee-exclusive)
  const DEALER_FEE = 83n; // fixed_fee + server_fee
  const NETWORK_FEE = 60n; // measured on-chain
  const PAY = BASE + DEALER_FEE; // 1639 — what the user reviewed and approved
  /** What the wallet's policy-asset net outflow actually is: the dealer's take plus
   *  the network fee (which lwk includes in the policy-asset net). */
  const SENT = PAY + NETWORK_FEE;

  function receiveExactTerms(maxSendAmount: bigint): VerifyDealerPsetTerms {
    return baseTerms({
      // Fee-inclusive, matching what executeInstantSwap now passes: the gate
      // measures the wallet's net policy-asset outflow, which includes the dealer
      // fee, so a fee-exclusive sendAmount trips check 2 before 2a is reached.
      sendAmount: PAY,
      minRecvAmount: 100_000_000n, // 1.00 USDt
      maxFee: 1000n,
      maxSendAmount,
    });
  }

  it("accepts the real charge when the cap is fee-INCLUSIVE (1639 * 105/100)", () => {
    const terms = receiveExactTerms((PAY * 105n) / 100n); // 1720
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -SENT, [USDT]: 100_000_000n },
      { [LBTC]: NETWORK_FEE },
    );
    const res = verifyDealerPset(pset, wollet, terms);
    expect(res.ok).toBe(true);
  });

  it("REGRESSION: the old fee-exclusive cap (1556 * 105/100) rejects that same swap", () => {
    // This is the bug, pinned. If the preview ever reverts to a fee-exclusive
    // sendAmount, receive-exact swaps break again with a misleading rate error.
    const staleCap = (BASE * 105n) / 100n; // 1633
    expect(staleCap).toBeLessThan(PAY); // the cap sits below the real charge
    const terms = { ...receiveExactTerms(staleCap), maxSendAmount: staleCap };
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -SENT, [USDT]: 100_000_000n },
      { [LBTC]: NETWORK_FEE },
    );
    const res = verifyDealerPset(pset, wollet, terms);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/user-approved cap/);
  });

  it("still rejects an outflow above the fee-inclusive cap", () => {
    // The cap must remain a real bound, not merely loosened enough to pass.
    const cap = (PAY * 105n) / 100n; // 1720
    const overCap = cap + NETWORK_FEE + 2n; // just past cap + fee + TOL
    const terms = receiveExactTerms(cap);
    const { pset, wollet } = mockPsetWollet(
      { [LBTC]: -overCap, [USDT]: 100_000_000n },
      { [LBTC]: NETWORK_FEE },
    );
    const res = verifyDealerPset(pset, wollet, terms);
    expect(res.ok).toBe(false);
  });
});
