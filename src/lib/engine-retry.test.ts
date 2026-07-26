// Tests for the engine-send retry predicates.
//
// These decide whether a failed offscreen engine call is retried. Getting the
// distinction wrong is user-visible in both directions:
//   - too narrow → the "engine error" banner on first load returns (the bug this fixes)
//   - too broad  → a genuine engine failure is silently retried, doubling the work
//                  and masking the real cause

import { describe, expect, it } from "vitest";
import { isNoReceiverError, shouldRetryEngineSend } from "./engine-retry";

describe("isNoReceiverError", () => {
  it("matches Chrome's real no-listener rejection", () => {
    // Verbatim Chrome wording — the whole point is to catch this exact string.
    expect(
      isNoReceiverError(
        new Error(
          "Could not establish connection. Receiving end does not exist.",
        ),
      ),
    ).toBe(true);
  });

  it("matches either half of the wording independently", () => {
    // Chrome has shipped both phrasings; neither should be load-bearing alone.
    expect(isNoReceiverError(new Error("Receiving end does not exist."))).toBe(true);
    expect(isNoReceiverError(new Error("Could not establish connection."))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isNoReceiverError(new Error("RECEIVING END DOES NOT EXIST"))).toBe(true);
  });

  it("accepts a non-Error thrown value", () => {
    // browser.runtime can reject with a bare string.
    expect(isNoReceiverError("Receiving end does not exist.")).toBe(true);
  });

  it("does NOT match real engine or wallet failures", () => {
    // Retrying any of these would hide a genuine fault.
    for (const msg of [
      "Keystore is locked",
      "Not enough LBTC to pay the network fee.",
      "recursive use of an object detected which would lead to unsafe aliasing in rust",
      "rate fetch timed out",
      "engine error",
      "No price source available for JPY",
    ]) {
      expect(isNoReceiverError(new Error(msg)), msg).toBe(false);
    }
  });
});

describe("shouldRetryEngineSend", () => {
  it("retries when sendMessage resolves with no value", () => {
    // Chrome resolves `undefined` when a message goes unanswered — the
    // resolve-shaped version of "nobody was listening".
    expect(shouldRetryEngineSend(undefined)).toBe(true);
  });

  it("does NOT retry a real engine error reply", () => {
    // `ok: false` means the engine ran and reported a failure. Retrying it would
    // double the work and obscure the cause.
    expect(shouldRetryEngineSend({ ok: false, error: "Keystore is locked" })).toBe(false);
  });

  it("does NOT retry a successful reply", () => {
    expect(shouldRetryEngineSend({ ok: true, value: 42 })).toBe(false);
    // Including falsy payloads — `ok: true` with a legitimately empty value.
    expect(shouldRetryEngineSend({ ok: true, value: null })).toBe(false);
    expect(shouldRetryEngineSend({ ok: true, value: 0 })).toBe(false);
  });

  it("does not treat null as a missing reply", () => {
    // Only `undefined` is Chrome's no-answer signal; `null` would be a real
    // (if malformed) reply and should fall through to the ok-check instead.
    expect(shouldRetryEngineSend(null)).toBe(false);
  });
});
