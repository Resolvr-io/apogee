// Tests for the consolidation landing predicate.
//
// The predicate decides when the Coins view's pending card clears. It must
// fire on a PARTIAL spend too: if the balance moves between prepare and
// broadcast, coin selection may leave one snapshotted outpoint unspent, and
// an "all inputs gone" reading would hold the card open forever.
import { describe, expect, it } from "vitest";
import { consolidationLanded } from "./consolidation";

describe("consolidationLanded", () => {
  const spent = ["aa:0", "bb:1", "cc:2"];

  it("is false while every spent outpoint is still present", () => {
    expect(consolidationLanded(spent, new Set(["aa:0", "bb:1", "cc:2", "dd:0"]))).toBe(false);
  });

  it("is true once all spent outpoints are gone", () => {
    expect(consolidationLanded(spent, new Set(["dd:0"]))).toBe(true);
  });

  it("is true when only some spent outpoints are gone", () => {
    expect(consolidationLanded(spent, new Set(["aa:0", "cc:2"]))).toBe(true);
  });

  it("is false for an empty spend set (nothing to wait for never lands)", () => {
    expect(consolidationLanded([], new Set())).toBe(false);
  });
});
