// The moon's exit curve is worth pinning: the dead zone is what keeps the moon
// from twitching on micro-scrolls at the top of the list, and the ease is what
// makes the exit read as the intro's descend reversed rather than a linear
// scrub. scene-scroll.ts is otherwise side-effectful (documentElement var +
// listeners) and lives behind the reduceMotion guard, so only moonRise is
// pure enough to test directly.

import { describe, expect, it } from "vitest";
import { moonRise } from "./scene-scroll";

describe("moonRise", () => {
  it("holds the apogee inside the dead zone", () => {
    expect(moonRise(0)).toBe(0);
    expect(moonRise(89)).toBe(0); // COLLAPSE_THRESHOLD_PX, imported by scene-scroll
  });

  it("is fully off the panel by the end of the range", () => {
    expect(moonRise(329)).toBe(1);
    expect(moonRise(10_000)).toBe(1);
  });

  it("rises monotonically between them, eased (fast away, slow settle)", () => {
    const quarter = moonRise(149);
    const half = moonRise(209);
    expect(quarter).toBeGreaterThan(0);
    expect(half).toBeGreaterThan(quarter);
    expect(half).toBeLessThan(1);
    // ease-out: at the halfway scroll the moon is more than halfway out —
    // a linear map would sit at exactly 0.5.
    expect(half).toBeGreaterThan(0.5);
  });
});
