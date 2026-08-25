// The strike decision is pure enough to test directly, and worth pinning: every
// rule here exists because the alternative misfires in a way that's obvious on
// screen but easy to reintroduce (replaying on every poll, on a denomination
// toggle, replaying on a remount, or never firing at all under StrictMode's
// double render).
//
// The effect body inside useBalanceStrike (clearing a latched `strike` flag on an
// early return, the timeout that ends it) is NOT covered here: "react" is mocked
// below so __shouldStrike can be imported without a renderer, and the mocked
// useEffect never invokes its callback. That fix is inspection-verified only.
// The hook's *subscription* is reachable though, and pinned at the bottom — the
// re-strike on a manual sync depends entirely on that notification firing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Framework-free (see its own doc comment) — safe as a normal static import
// even though "react" is mocked below.
import { MAX_DIGIT_STRIKE_MS } from "@/sidepanel/digit-cycle";

vi.mock("react", () => ({
  useEffect: vi.fn(),
  useState: vi.fn(() => [false, vi.fn()]),
  useSyncExternalStore: vi.fn((_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot()),
}));

const react = await import("react");
const { armBalanceStrike, restrikeBalance, __shouldStrike, useBalanceStrike } =
  await import("./balance-warmup");
// Mirrors the +100ms margin in balance-warmup.ts's STRIKE_MS — not imported
// directly since it isn't exported (only the memo/flag lifetime need it, both
// internal), so this is the outside view of the same window.
const STRIKE_MS = MAX_DIGIT_STRIKE_MS + 100;

describe("balance strike", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    armBalanceStrike();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("strikes the first final figure after arming, once", () => {
    expect(__shouldStrike("2157431", false)).toBe(true);
    // Same state again (a poll, a re-render, StrictMode's second effect pass)
    // must reuse the decision rather than counting as a fresh event.
    expect(__shouldStrike("2157431", false)).toBe(true);
  });

  it("does not strike while the figure is still settling", () => {
    expect(__shouldStrike("2157431", true)).toBe(false);
  });

  it("strikes when a settling figure becomes final", () => {
    expect(__shouldStrike("2157431", true)).toBe(false); // consumes the arming path
    expect(__shouldStrike("2500000", false)).toBe(true); // confirmed
  });

  it("strikes when one final figure replaces another", () => {
    expect(__shouldStrike("2157431", false)).toBe(true); // armed
    expect(__shouldStrike("2157431", false)).toBe(true); // memo
    expect(__shouldStrike("3000000", false)).toBe(true); // new confirmed total
  });

  it("does not re-strike the same final figure once its memo has expired", () => {
    // Within the memo window, a repeated key is idempotent (see the first
    // test) — that's not the same claim as "the balance didn't change".
    // Advancing past STRIKE_MS forces a fresh computation, so this is what
    // actually exercises armed/lastUnconfirmed/lastSats rather than the memo.
    expect(__shouldStrike("2157431", false)).toBe(true); // armed
    vi.advanceTimersByTime(STRIKE_MS + 1);
    expect(__shouldStrike("2157431", false)).toBe(false); // same figure, no event
  });

  it("re-strikes a later change even after the memo has expired", () => {
    expect(__shouldStrike("2157431", false)).toBe(true); // armed
    vi.advanceTimersByTime(STRIKE_MS + 1);
    expect(__shouldStrike("3000000", false)).toBe(true); // genuinely new total
  });

  it("does not replay on a remount with an unchanged figure", () => {
    // A remount re-imports nothing (module state persists) but re-renders from
    // scratch — the reachable case is the step-up screen, which unmounts
    // Wallet without calling armBalanceStrike(). Modeled here as: the memo
    // expires, then the "same" state is asked about again.
    expect(__shouldStrike("2157431", false)).toBe(true);
    vi.advanceTimersByTime(STRIKE_MS + 1);
    expect(__shouldStrike("2157431", false)).toBe(false);
  });

  it("re-arms on lock", () => {
    expect(__shouldStrike("2157431", false)).toBe(true);
    armBalanceStrike();
    // After a lock the same figure is a first display again.
    expect(__shouldStrike("2157431", false)).toBe(true);
  });

  it("re-strikes an unchanged figure after a manual sync", () => {
    // The whole point of the Sync button's strike: the balance hasn't moved (a
    // quiet poll already established that, past the memo window, and got no
    // strike), and pressing Sync still relights the numerals.
    expect(__shouldStrike("2157431", false)).toBe(true); // first display
    vi.advanceTimersByTime(STRIKE_MS + 1);
    expect(__shouldStrike("2157431", false)).toBe(false); // a poll that found nothing
    restrikeBalance(); // the Sync button, on a successful sync
    expect(__shouldStrike("2157431", false)).toBe(true);
  });

  it("notifies a mounted hero when a manual re-strike happens", () => {
    // Flipping the flag isn't enough on its own — the strike is decided in an
    // effect keyed on the balance, so a re-arm that leaves the figure unchanged
    // has to change this snapshot for the decision to be re-run at all.
    useBalanceStrike("2157431", false, true);
    const call = vi.mocked(react.useSyncExternalStore).mock.calls.at(-1);
    const [subscribe, getSnapshot] = call as unknown as [
      (onChange: () => void) => () => void,
      () => number,
    ];

    const onChange = vi.fn();
    const unsubscribe = subscribe(onChange);
    const before = getSnapshot();
    restrikeBalance();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(getSnapshot()).not.toBe(before);

    unsubscribe();
    restrikeBalance();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("delivers no notification on the lock re-arm", () => {
    // The lock paths call armBalanceStrike() while the hero is still mounted,
    // and a notification there forces a re-render that re-runs the effect and
    // consumes the arming on the locking screen — the next unlock would find
    // nothing left to strike. This pin keeps arming split into a silent and a
    // notifying half.
    useBalanceStrike("2157431", false, true);
    const call = vi.mocked(react.useSyncExternalStore).mock.calls.at(-1);
    const [subscribe, getSnapshot] = call as unknown as [
      (onChange: () => void) => () => void,
      () => number,
    ];

    const onChange = vi.fn();
    subscribe(onChange);
    const before = getSnapshot();
    armBalanceStrike(); // a lock
    expect(onChange).not.toHaveBeenCalled();
    expect(getSnapshot()).toBe(before);
    // ...but it still armed: the next figure shown is a first display again.
    expect(__shouldStrike("2157431", false)).toBe(true);
  });
});
