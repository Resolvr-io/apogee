// The measurements are the load-bearing part of the hero collapse — a stale or
// misattributed height under-sizes the foot spacer and reopens the clamp bounce
// the whole mechanism exists to prevent — so they're pinned here. The hook's
// observers (the sentinel's IntersectionObserver, the frame's ResizeObserver)
// need a real layout engine and are browser-verified.

import { describe, expect, it } from "vitest";
import { observedHeights, spacerHeight, type CollapseHeights } from "./hero-collapse";

const none: CollapseHeights = { expanded: null, compact: null };

describe("observedHeights", () => {
  it("records a measurement under whichever mode it was taken in", () => {
    expect(observedHeights(none, false, 320)).toEqual({ expanded: 320, compact: null });
    expect(observedHeights({ expanded: 320, compact: null }, true, 130)).toEqual({
      expanded: 320,
      compact: 130,
    });
  });

  it("keeps the object identity when the height is unchanged", () => {
    const h = { expanded: 320, compact: 130 };
    expect(observedHeights(h, false, 320)).toBe(h);
  });

  it("lets a later measurement in the same slot replace an earlier one", () => {
    // The expanded height is not fixed — the chart opens and closes.
    expect(observedHeights({ expanded: 320, compact: 130 }, false, 512)).toEqual({
      expanded: 512,
      compact: 130,
    });
  });
});

describe("spacerHeight", () => {
  it("is zero unless compact, or with no expanded height yet", () => {
    expect(spacerHeight({ expanded: 320, compact: 130 }, false, 200)).toBe(0);
    expect(spacerHeight({ expanded: null, compact: 130 }, true, 200)).toBe(0);
  });

  it("is zero when the list is long enough to need none of it", () => {
    // Transitions fire at the threshold (~89px); a range of threshold + fold
    // or more can absorb the fold without clamping, so the spacer — and the
    // blank band it paints after the last row — is pure cost.
    expect(spacerHeight({ expanded: 320, compact: 130 }, true, 10_000)).toBe(0);
    expect(spacerHeight({ expanded: 320, compact: 130 }, true, 279)).toBe(0);
  });

  it("carries only the shortfall on a short list", () => {
    // range 250, fold 190, threshold 89: need 29.
    expect(spacerHeight({ expanded: 320, compact: 130 }, true, 250)).toBe(29);
  });

  it("caps at the fold even when the list is nearly unscrollable", () => {
    expect(spacerHeight({ expanded: 320, compact: 130 }, true, 0)).toBe(190);
  });

  it("assumes the worst case before compact has been measured", () => {
    // Unmeasured compact treats the fold as the full expanded height — an
    // under-sized spacer in that gap is the clamp bounce. Still clamped by
    // the same geometry rule.
    expect(spacerHeight({ expanded: 320, compact: null }, true, 10_000)).toBe(0);
    expect(spacerHeight({ expanded: 320, compact: null }, true, 250)).toBe(159);
  });

  it("falls back to the full fold when the geometry can't be read", () => {
    expect(spacerHeight({ expanded: 320, compact: 130 }, true, null)).toBe(190);
  });

  it("floors at zero rather than trusting compact ≤ expanded", () => {
    expect(spacerHeight({ expanded: 100, compact: 130 }, true, 0)).toBe(0);
  });
});
