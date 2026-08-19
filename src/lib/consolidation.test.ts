// Tests for the consolidation landing predicate.
//
// The predicate decides when the Coins view's pending card clears. It must
// fire on a PARTIAL spend too: if the balance moves between prepare and
// broadcast, coin selection may leave one snapshotted outpoint unspent, and
// an "all inputs gone" reading would hold the card open forever.
import { describe, expect, it } from "vitest";
import {
  bumpPendingPolls,
  CONSOLIDATION_SETTLE_POLLS,
  consolidationLanded,
  exhaustedBroadcastIds,
  landedBroadcastIds,
  type ConsolidationBroadcast,
} from "./consolidation";

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

// The Coins view (Wallet.tsx) used to track pending broadcasts in component
// state, which unmounted on every trip through Settings, and a single shared
// poll counter for all of them. These two predicates are what replaced that —
// per-entry, and (unlike the settle effect that calls them) testable without a
// renderer.
describe("landedBroadcastIds / exhaustedBroadcastIds", () => {
  function entry(overrides: Partial<ConsolidationBroadcast> = {}): ConsolidationBroadcast {
    return { txid: "tx", spent: ["aa:0"], polls: 0, ...overrides };
  }

  it("names only the broadcasts whose spend has landed", () => {
    const broadcasts = {
      lbtc: entry({ spent: ["aa:0"] }), // still present below — not landed
      usdt: entry({ spent: ["bb:1"] }), // gone below — landed
    };
    const present = new Set(["aa:0"]);
    expect(landedBroadcastIds(broadcasts, present)).toEqual(["usdt"]);
  });

  it("names only the broadcast whose OWN budget is exhausted", () => {
    // Two consolidations at different ages — a shared counter would have let
    // starting `fresh` reset `old`'s remaining budget, or marked both stuck at
    // once. Per-entry, only `old` is named.
    const broadcasts = {
      old: entry({ polls: CONSOLIDATION_SETTLE_POLLS }),
      fresh: entry({ polls: 1 }),
    };
    expect(exhaustedBroadcastIds(broadcasts)).toEqual(["old"]);
  });

  it("does not re-name a broadcast already marked stuck", () => {
    const broadcasts = {
      old: entry({ polls: CONSOLIDATION_SETTLE_POLLS, stuck: true }),
    };
    expect(exhaustedBroadcastIds(broadcasts)).toEqual([]);
  });

  it("is empty when no broadcast has reached its budget", () => {
    const broadcasts = { fresh: entry({ polls: CONSOLIDATION_SETTLE_POLLS - 1 }) };
    expect(exhaustedBroadcastIds(broadcasts)).toEqual([]);
  });
});

// This is the write side of the same fix: exhaustedBroadcastIds reads `polls`
// per entry, and this is what actually increments it per entry. Before #89,
// this was a single ref shared by every pending broadcast.
describe("bumpPendingPolls", () => {
  function entry(overrides: Partial<ConsolidationBroadcast> = {}): ConsolidationBroadcast {
    return { txid: "tx", spent: ["aa:0"], polls: 0, ...overrides };
  }

  it("increments every pending entry independently", () => {
    const broadcasts = { a: entry({ polls: 0 }), b: entry({ polls: 3 }) };
    const next = bumpPendingPolls(broadcasts);
    expect(next.a.polls).toBe(1);
    expect(next.b.polls).toBe(4);
  });

  it("leaves a stuck entry's count alone", () => {
    const broadcasts = { a: entry({ polls: 5, stuck: true }) };
    expect(bumpPendingPolls(broadcasts).a.polls).toBe(5);
  });

  it("does not mutate the input", () => {
    const broadcasts = { a: entry({ polls: 0 }) };
    bumpPendingPolls(broadcasts);
    expect(broadcasts.a.polls).toBe(0);
  });
});
