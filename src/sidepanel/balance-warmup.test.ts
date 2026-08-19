// The strike decision is pure enough to test directly, and worth pinning: every
// rule here exists because the alternative misfires in a way that's obvious on
// screen but easy to reintroduce (replaying on every poll, on a denomination
// toggle, replaying on a remount, or never firing at all under StrictMode's
// double render).
//
// useBalanceStrike itself (the effect that clears a latched `strike` flag on an
// early return) is NOT covered here: "react" is mocked below so __shouldStrike
// can be imported without a renderer, which means the hook's own body never
// runs. That fix is inspection-verified only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Framework-free (see its own doc comment) — safe as a normal static import
// even though "react" is mocked below.
import { MAX_DIGIT_STRIKE_MS } from "@/sidepanel/digit-cycle";

vi.mock("react", () => ({ useEffect: vi.fn(), useState: vi.fn(() => [false, vi.fn()]) }));

const { armBalanceStrike, __shouldStrike } = await import("./balance-warmup");
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
});
