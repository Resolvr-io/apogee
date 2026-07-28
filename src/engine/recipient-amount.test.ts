import { describe, expect, it } from "vitest";
import { recipientAmount, type RecipientAmountInput } from "./recipient-amount";

const POLICY = "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d";
const TOKEN = "ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2";

/** An ordinary external LBTC send: 100,000 sats out plus a 33-sat fee. */
function base(over: Partial<RecipientAmountInput> = {}): RecipientAmountInput {
  return {
    deltas: { [POLICY]: -100_033 },
    fee: 33,
    recipientsCount: 1,
    sats: 100_000,
    drain: false,
    isToken: false,
    policyAssetHex: POLICY,
    policyBalance: 138_618,
    ...over,
  };
}

describe("external sends — amount comes from the PSET", () => {
  it("reports the recipient amount for an LBTC send", () => {
    expect(recipientAmount(base())).toEqual({ amount: 100_000, toSelf: false });
  });

  it("ignores the caller's `sats` entirely", () => {
    // The whole point of deriving from the PSET: a wrong caller figure must not
    // change what the user is shown for funds actually leaving the wallet.
    expect(recipientAmount(base({ sats: 1 })).amount).toBe(100_000);
    expect(recipientAmount(base({ sats: 9_999_999 })).amount).toBe(100_000);
  });

  it("reports an LBTC drain from the deltas", () => {
    expect(
      recipientAmount(base({ drain: true, sats: 0, deltas: { [POLICY]: -138_618 } })),
    ).toEqual({ amount: 138_585, toSelf: false });
  });

  it("reports a token send without subtracting the fee from the token", () => {
    // The fee is LBTC, so it lives wholly in the policy delta.
    expect(
      recipientAmount(
        base({
          isToken: true,
          assetId: TOKEN,
          deltas: { [POLICY]: -33, [TOKEN]: -5_000 },
        }),
      ),
    ).toEqual({ amount: 5_000, toSelf: false });
  });
});

describe("self-sends — the case that reported 0", () => {
  it("reports the real amount for a fixed-amount LBTC self-send", () => {
    // The reported bug: net delta is only the fee, so the PSET-derived formula
    // yields -(-33) - 33 = 0.
    const selfSend = base({ recipientsCount: 0, deltas: { [POLICY]: -33 } });
    expect(recipientAmount(selfSend)).toEqual({ amount: 100_000, toSelf: true });
  });

  it("reports balance minus fee for an LBTC drain to ourselves", () => {
    // `sats` is 0 on a drain — the builder sets the amount — so falling back to it
    // would still show 0 here. This is the second bug behind the first.
    expect(
      recipientAmount(
        base({ recipientsCount: 0, deltas: { [POLICY]: -33 }, drain: true, sats: 0 }),
      ),
    ).toEqual({ amount: 138_585, toSelf: true });
  });

  it("never returns a negative amount when the balance read comes back empty", () => {
    // balanceToRecord() yields {} if lwk's balance JSON throws; `0 - fee` would
    // otherwise render as "-33 sats" on a signing screen.
    expect(
      recipientAmount(
        base({
          recipientsCount: 0,
          deltas: { [POLICY]: -33 },
          drain: true,
          sats: 0,
          policyBalance: 0,
        }),
      ),
    ).toEqual({ amount: 0, toSelf: true });
  });

  it("reports a token self-send in token units", () => {
    expect(
      recipientAmount(
        base({
          isToken: true,
          assetId: TOKEN,
          recipientsCount: 0,
          deltas: { [POLICY]: -33, [TOKEN]: 0 },
          sats: 5_000,
        }),
      ),
    ).toEqual({ amount: 5_000, toSelf: true });
  });
});

describe("the self-send predicate fails safe", () => {
  it("does not claim a self-send when the policy delta exceeds the fee", () => {
    // The dangerous direction: an output that really is external but which lwk
    // omitted from recipients(). The delta still shows the outflow, so we must
    // fall back to the PSET-derived amount rather than saying "returns to you".
    const suspect = base({ recipientsCount: 0, deltas: { [POLICY]: -100_033 } });
    expect(recipientAmount(suspect)).toEqual({ amount: 100_000, toSelf: false });
  });

  it("does not claim a token self-send when the token actually moved", () => {
    const suspect = base({
      isToken: true,
      assetId: TOKEN,
      recipientsCount: 0,
      deltas: { [POLICY]: -33, [TOKEN]: -5_000 },
      sats: 5_000,
    });
    expect(recipientAmount(suspect)).toEqual({ amount: 5_000, toSelf: false });
  });

  it("requires both signals: matching deltas alone are not enough", () => {
    // Same deltas either way — a policy move of exactly the fee, which is the
    // self-send signature. Only the presence of an output outside the wallet
    // differs, and that alone must decide it.
    const deltas = { [POLICY]: -33 };
    expect(recipientAmount(base({ deltas, recipientsCount: 0 })).toSelf).toBe(true);
    expect(recipientAmount(base({ deltas, recipientsCount: 1 })).toSelf).toBe(false);
  });
});
