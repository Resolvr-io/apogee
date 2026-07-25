// Tests for swap error classification.
//
// `swapErrorKind` is fund-safety-relevant, not cosmetic: it decides whether the
// user-reviewed quote may be reused when Confirm is pressed again. Only "auth"
// may reuse it — the swap terms didn't change, the user just needs to re-enter
// their password. Every other kind means the dealer's terms may have moved, and
// re-sending the stale `reviewedSendAmount`/`reviewedRecvAmount` would re-arm the
// gate's independent caps against terms the user never actually approved.
//
// The strings below are copied from the real throw sites so this suite fails if
// that wording drifts (the classifier matches on substrings):
//   - background/index.ts:550        "Enter your password to swap."
//   - orchestrator.ts:315            `verification gate rejected the PSET: ${reason}`
//   - orchestrator.ts:209/349        `no UTXOs found for send asset ${id}`
//   - orchestrator.ts waitForQuote   "dealer error: …" / "timed out waiting for dealer quote"
//   - background/index.ts rethrowSwapError  `${LOW_BALANCE_PREFIX}<units>` (SW-only marker)
//   - keystore.ts:162/164            "UNLOCK_BLOCKED" / `UNLOCK_THROTTLED:${epochMs}`

import { describe, expect, it } from "vitest";
// Imported from ./errors, not ./wallet-client: the latter pulls in @/lib/ext,
// which touches the `chrome` global at module load and isn't available here.
import { lowBalanceAvailable, swapErrorKind, swapErrorMessage } from "./errors";
import { LOW_BALANCE_PREFIX } from "@/sideswap/constants";

describe("swapErrorKind", () => {
  it("classifies a missing/wrong step-up password as auth (quote stays reusable)", () => {
    expect(swapErrorKind(new Error("Enter your password to swap."))).toBe("auth");
  });

  it("classifies throttle refusals as auth — verifyPassword shares the unlock throttle", () => {
    // A cooldown must not discard the reviewed quote: the user waits, then retries
    // the same swap. Discarding it would force a re-quote for a non-swap reason.
    expect(swapErrorKind(new Error(`UNLOCK_THROTTLED:${Date.now() + 30_000}`))).toBe("auth");
    expect(swapErrorKind(new Error("UNLOCK_BLOCKED"))).toBe("auth");
  });

  it("classifies a verification-gate rejection as stale-quote", () => {
    const err = new Error(
      "verification gate rejected the PSET: spend 1200 exceeds user-approved cap 1000 + fee 0",
    );
    expect(swapErrorKind(err)).toBe("stale-quote");
  });

  it("classifies dealer failures as stale-quote", () => {
    expect(swapErrorKind(new Error("dealer error: rate expired"))).toBe("stale-quote");
    expect(swapErrorKind(new Error(`${LOW_BALANCE_PREFIX}400000`))).toBe("stale-quote");
    expect(swapErrorKind(new Error("timed out waiting for dealer quote"))).toBe("stale-quote");
  });

  it("defaults to unknown for unrecognized failures", () => {
    // Anything unrecognized must NOT be treated as auth — the caller drops the
    // quote for every non-auth kind, which is the conservative direction.
    expect(swapErrorKind(new Error("SideSwap WebSocket closed"))).toBe("unknown");
    expect(swapErrorKind(new Error("no UTXOs found for send asset abc123"))).toBe("unknown");
  });

  it("never classifies a non-auth failure as auth (the only quote-reusing kind)", () => {
    const nonAuth = [
      "verification gate rejected the PSET: receive 5 < minimum 10",
      "dealer error: no liquidity",
      `${LOW_BALANCE_PREFIX}400000`,
      "timed out waiting for dealer quote",
      "SideSwap WebSocket closed",
      "Watch-only wallets can't sign or swap.",
      "either sendAmount or recvAmount must be specified",
    ];
    for (const msg of nonAuth) {
      expect(swapErrorKind(new Error(msg)), msg).not.toBe("auth");
    }
  });
});

describe("swapErrorMessage", () => {
  it("does not mislabel the form's balance-validation copy as rate drift", () => {
    // Regression: an earlier version matched the bare substring "exceeds", which
    // also swallowed this unrelated message and reported it as a moved rate.
    const msg = swapErrorMessage(new Error("Amount exceeds your available balance."));
    expect(msg).toBe("Amount exceeds your available balance.");
    expect(msg).not.toMatch(/rate moved/i);
  });

  it("explains a gate rejection in plain language and tells the user to re-quote", () => {
    const msg = swapErrorMessage(
      new Error("verification gate rejected the PSET: spend 1200 exceeds offered 1000 + fee 0"),
    );
    expect(msg).toMatch(/not signed/i);
    expect(msg).toMatch(/fresh quote/i);
    expect(msg).not.toMatch(/PSET/); // no internals leaked to the user
  });

  it("renders cooldown-aware copy for a throttled password attempt", () => {
    const msg = swapErrorMessage(new Error(`UNLOCK_THROTTLED:${Date.now() + 45_000}`));
    expect(msg).toMatch(/too many failed attempts/i);
    expect(msg).not.toMatch(/UNLOCK_THROTTLED/); // raw code never shown
  });

  it("passes the already-friendly password prompt through unchanged", () => {
    expect(swapErrorMessage(new Error("Enter your password to swap."))).toBe(
      "Enter your password to swap.",
    );
  });

  it("translates dealer and balance failures", () => {
    expect(swapErrorMessage(new Error(`${LOW_BALANCE_PREFIX}400000`))).toMatch(/can't fill/i);
    expect(swapErrorMessage(new Error("timed out waiting for dealer quote"))).toMatch(
      /didn't respond in time/i,
    );
    expect(swapErrorMessage(new Error("dealer error: rate expired"))).toMatch(/declined/i);
  });

  it("never leaks the machine-readable LowBalance amount suffix into user copy", () => {
    // The SW encodes the dealer's fillable amount as `:<units>` so it survives the
    // SW→UI hop; the UI reads it via lowBalanceAvailable and formats it with asset
    // precision. It must never appear raw in the message.
    const msg = swapErrorMessage(new Error(`${LOW_BALANCE_PREFIX}400000`));
    expect(msg).toMatch(/can't fill/i);
    expect(msg).not.toMatch(/400000/);
    expect(msg).not.toMatch(/SWAP_LOW_BALANCE/);
  });

  it("falls back to the raw message when nothing matches", () => {
    expect(swapErrorMessage(new Error("something unexpected"))).toBe("something unexpected");
  });
});

describe("lowBalanceAvailable", () => {
  it("parses the dealer's fillable amount out of the encoded message", () => {
    // Encoded by rethrowSwapError in background/index.ts, because only an Error's
    // message survives the SW→UI structured-clone hop.
    expect(lowBalanceAvailable(new Error(`${LOW_BALANCE_PREFIX}400000`))).toBe(400000n);
  });

  it("handles amounts beyond Number.MAX_SAFE_INTEGER without precision loss", () => {
    // Parsed as BigInt, so a whale-sized figure survives exactly.
    const big = "9007199254740993"; // MAX_SAFE_INTEGER + 2
    expect(lowBalanceAvailable(new Error(`${LOW_BALANCE_PREFIX}${big}`))).toBe(BigInt(big));
  });

  it("ignores a dealer error_msg that echoes the marker (no injected amount)", () => {
    // A dealer failure always arrives as `dealer error: ${error_msg}` where
    // error_msg is server-controlled. Before the parse was anchored, a dealer
    // could put the marker in its own text and have the UI render a fabricated
    // "the dealer can fill up to 999999999" figure. The `^` anchor blocks it,
    // since `dealer error: ` always occupies position 0.
    const hostile = new Error(`dealer error: ${LOW_BALANCE_PREFIX}999999999`);
    expect(lowBalanceAvailable(hostile)).toBeNull();
    // ...and it must not be dressed up as a LowBalance refusal either.
    expect(swapErrorMessage(hostile)).not.toMatch(/can't fill/i);
    expect(swapErrorMessage(hostile)).toMatch(/declined/i);
    // Still the conservative kind, so the reviewed quote is dropped.
    expect(swapErrorKind(hostile)).toBe("stale-quote");
  });

  it("returns null when there's no amount or it isn't a LowBalance error", () => {
    expect(lowBalanceAvailable(new Error(LOW_BALANCE_PREFIX))).toBeNull();
    expect(lowBalanceAvailable(new Error("dealer error: rate expired"))).toBeNull();
    expect(lowBalanceAvailable(new Error("verification gate rejected the PSET: x"))).toBeNull();
  });
});
