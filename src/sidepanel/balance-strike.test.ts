// The strike decision and the arming notification are pure enough to test
// directly, and worth pinning: every rule here exists because the alternative
// misfires in a way that's obvious on screen but easy to reintroduce
// (replaying on every poll, on a denomination toggle, replaying on a remount,
// never firing at all under StrictMode's double render, or the lock re-arm
// being consumed on the locking screen).
//
// The split that made this file possible is itself one of the things it
// protects: balance-strike.ts is framework-free, so these tests import it
// plainly — no react mock (which stubbed the whole module and would break
// opaquely the day balance-warmup.ts needed a new hook), no __shouldStrike
// seam. useBalanceStrike (the effect, the epoch, the hidden-time correction)
// still needs a renderer and is browser-verified.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Framework-free (see its own doc comment) — a normal static import.
import { MAX_DIGIT_STRIKE_MS } from "@/sidepanel/digit-cycle";
import {
  STRIKE_MS,
  armBalanceStrike,
  cancelBalanceStrike,
  getArmVersion,
  restrikeBalance,
  shouldStrike,
  subscribeToArming,
} from "./balance-strike";

describe("balance strike", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    armBalanceStrike();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("strikes the first final figure after arming, once", () => {
    expect(shouldStrike("2157431", false)).toBe(true);
    // Same state again (a poll, a re-render, StrictMode's second effect pass)
    // must reuse the decision rather than counting as a fresh event.
    expect(shouldStrike("2157431", false)).toBe(true);
  });

  it("does not strike while the figure is still settling", () => {
    expect(shouldStrike("2157431", true)).toBe(false);
  });

  it("strikes when a settling figure becomes final", () => {
    expect(shouldStrike("2157431", true)).toBe(false); // consumes the arming path
    expect(shouldStrike("2500000", false)).toBe(true); // confirmed
  });

  it("strikes when one final figure replaces another", () => {
    expect(shouldStrike("2157431", false)).toBe(true); // armed
    expect(shouldStrike("2157431", false)).toBe(true); // memo
    expect(shouldStrike("3000000", false)).toBe(true); // new confirmed total
  });

  it("does not re-strike the same final figure once its memo has expired", () => {
    // Within the memo window, a repeated key is idempotent (see the first
    // test) — that's not the same claim as "the balance didn't change".
    // Advancing past STRIKE_MS forces a fresh computation, so this is what
    // actually exercises armed/lastUnconfirmed/lastSats rather than the memo.
    expect(shouldStrike("2157431", false)).toBe(true); // armed
    vi.advanceTimersByTime(STRIKE_MS + 1);
    expect(shouldStrike("2157431", false)).toBe(false); // same figure, no event
  });

  it("re-strikes a later change even after the memo has expired", () => {
    expect(shouldStrike("2157431", false)).toBe(true); // armed
    vi.advanceTimersByTime(STRIKE_MS + 1);
    expect(shouldStrike("3000000", false)).toBe(true); // genuinely new total
  });

  it("does not replay on a remount with an unchanged figure", () => {
    // A remount re-imports nothing (module state persists) but re-renders from
    // scratch — the reachable case is the step-up screen, which unmounts
    // Wallet without calling armBalanceStrike(). Modeled here as: the memo
    // expires, then the "same" state is asked about again.
    expect(shouldStrike("2157431", false)).toBe(true);
    vi.advanceTimersByTime(STRIKE_MS + 1);
    expect(shouldStrike("2157431", false)).toBe(false);
  });

  it("re-arms on lock", () => {
    expect(shouldStrike("2157431", false)).toBe(true);
    armBalanceStrike();
    // After a lock the same figure is a first display again.
    expect(shouldStrike("2157431", false)).toBe(true);
  });

  it("re-strikes an unchanged figure after a manual sync", () => {
    // The whole point of the Sync button's strike: the balance hasn't moved (a
    // quiet poll already established that, past the memo window, and got no
    // strike), and pressing Sync still relights the numerals.
    expect(shouldStrike("2157431", false)).toBe(true); // first display
    vi.advanceTimersByTime(STRIKE_MS + 1);
    expect(shouldStrike("2157431", false)).toBe(false); // a poll that found nothing
    restrikeBalance(); // the Sync button, on a successful sync
    expect(shouldStrike("2157431", false)).toBe(true);
  });

  it("keeps the strike window derived from the digit timings", () => {
    // Retuning digit-cycle must carry the decision window with it.
    expect(STRIKE_MS).toBe(MAX_DIGIT_STRIKE_MS + 100);
  });

  it("cancel stops a playing strike: the next read of the figure is static", () => {
    expect(shouldStrike("2157431", false)).toBe(true); // strike latched, flicker live
    cancelBalanceStrike(); // the denomination toggle
    expect(shouldStrike("2157431", false)).toBe(false);
  });

  it("a real balance change after a cancellation still strikes", () => {
    expect(shouldStrike("2157431", false)).toBe(true);
    cancelBalanceStrike();
    // Only the unit changed — the history the machine keeps is untouched, so a
    // genuine change still reads as one.
    expect(shouldStrike("3000000", false)).toBe(true);
  });

  it("cancel is a no-op while nothing plays: the pending arming survives", () => {
    // Toggling during the stars/settling phase (no strike decided yet) must not
    // spend the arming waiting for the numerals' arrival — rule 1 still fires.
    cancelBalanceStrike();
    expect(shouldStrike("2157431", false)).toBe(true);
  });
});

describe("arming notification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    armBalanceStrike();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifies a mounted hero when a manual re-strike happens", () => {
    // The strike is decided per render from the balance, so a re-arm that
    // leaves the figure unchanged has to change the arm version for the
    // decision to be re-run at all.
    const onChange = vi.fn();
    const unsubscribe = subscribeToArming(onChange);
    const before = getArmVersion();
    restrikeBalance();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(getArmVersion()).not.toBe(before);

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
    const onChange = vi.fn();
    const unsubscribe = subscribeToArming(onChange);
    const before = getArmVersion();
    armBalanceStrike(); // a lock
    expect(onChange).not.toHaveBeenCalled();
    expect(getArmVersion()).toBe(before);
    unsubscribe(); // listeners are module scope — never leak a spy forward
    // ...but it still armed: the next figure shown is a first display again.
    expect(shouldStrike("2157431", false)).toBe(true);
  });
});
