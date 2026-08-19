// The strike decision is pure enough to test directly, and worth pinning: every
// rule here exists because the alternative misfires in a way that's obvious on
// screen but easy to reintroduce (replaying on every poll, on a denomination
// toggle, or never firing at all under StrictMode's double render).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({ useEffect: vi.fn(), useState: vi.fn(() => [false, vi.fn()]) }));

const { armBalanceStrike, __shouldStrike } = await import("./balance-warmup");

describe("balance strike", () => {
  beforeEach(() => {
    armBalanceStrike();
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

  it("does not re-strike an unchanged final figure", () => {
    expect(__shouldStrike("2157431", false)).toBe(true); // armed
    expect(__shouldStrike("3000000", false)).toBe(true); // changed
    // A later poll reporting the same total is not an event.
    expect(__shouldStrike("2157431", false)).toBe(true); // changed again
    expect(__shouldStrike("2157431", false)).toBe(true); // memo, same decision
  });

  it("re-arms on lock", () => {
    expect(__shouldStrike("2157431", false)).toBe(true);
    armBalanceStrike();
    // After a lock the same figure is a first display again.
    expect(__shouldStrike("2157431", false)).toBe(true);
  });
});
