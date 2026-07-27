// Tests for the seed-phrase hand-off semantics.
//
// These properties are the security argument for scanning a seed at all (see
// docs/seed-qr-import.md): the phrase is parked point-to-point rather than
// broadcast, and it is readable exactly once, briefly.

import { describe, expect, it } from "vitest";
import { claimSecret, QR_SECRET_TTL_MS, type ParkedSecret } from "./qr-secret";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("claimSecret", () => {
  it("returns a freshly parked phrase", () => {
    const held: ParkedSecret = { value: PHRASE, at: 1_000 };
    expect(claimSecret(held, 1_000).value).toBe(PHRASE);
  });

  it("clears unconditionally, so a second claim yields nothing", () => {
    // The single-use property. `next` is always null — the caller writes it back,
    // so there is no branch where a claimed value survives.
    const held: ParkedSecret = { value: PHRASE, at: 1_000 };
    const first = claimSecret(held, 1_000);
    expect(first.value).toBe(PHRASE);
    expect(first.next).toBeNull();
    // Second claim against the cleared slot.
    expect(claimSecret(first.next, 1_100).value).toBeNull();
  });

  it("clears even when the value was already stale", () => {
    // A stale value must not be left parked for a later, luckier claim.
    const held: ParkedSecret = { value: PHRASE, at: 0 };
    const r = claimSecret(held, QR_SECRET_TTL_MS + 1);
    expect(r.value).toBeNull();
    expect(r.next).toBeNull();
  });

  it("refuses a phrase older than the TTL", () => {
    const held: ParkedSecret = { value: PHRASE, at: 0 };
    expect(claimSecret(held, QR_SECRET_TTL_MS - 1).value).toBe(PHRASE); // just inside
    expect(claimSecret(held, QR_SECRET_TTL_MS).value).toBeNull(); // boundary is exclusive
  });

  it("handles an empty slot", () => {
    expect(claimSecret(null, 5_000).value).toBeNull();
  });

  it("does not leak the phrase through the returned slot", () => {
    // Regression guard: an implementation that returned `held` as `next` would keep
    // the secret claimable, defeating single-use.
    const held: ParkedSecret = { value: PHRASE, at: 1_000 };
    expect(claimSecret(held, 1_000).next).toBeNull();
  });
});
