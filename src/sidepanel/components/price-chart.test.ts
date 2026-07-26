// Tests for the price trace's coordinate math.
//
// This is the part that fails silently: a flat or single-point series divides by a
// zero span, and NaN coordinates render as an empty <path> with no error anywhere.
// The engine guarantees >= 2 finite positive points, but the drawing code shouldn't
// depend on that to avoid emitting garbage.

import { describe, expect, it } from "vitest";
import { formatChange, formatScrubTime, tracePaths } from "./PriceChart";

/** Every number appearing in a path string — used to assert none are NaN. */
function coords(path: string): number[] {
  return (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
}

describe("tracePaths", () => {
  it("maps a rising series to a descending y (SVG y grows downward)", () => {
    const { line } = tracePaths([100, 200]);
    const [x0, y0, x1, y1] = coords(line);
    expect(x0).toBe(0); // first point pinned to the left edge
    expect(x1).toBe(300); // last point pinned to the right edge
    expect(y0).toBeGreaterThan(y1); // higher price => smaller y
  });

  it("produces no NaN for a flat series", () => {
    // span = max - min = 0. Without the `|| 1` guard every y is NaN.
    const { line, area } = tracePaths([64000, 64000, 64000]);
    expect(coords(line).every(Number.isFinite)).toBe(true);
    expect(coords(area).every(Number.isFinite)).toBe(true);
  });

  it("produces no NaN for a single point", () => {
    // i / (length - 1) divides by zero when there's one point.
    const { line, area } = tracePaths([64000]);
    expect(coords(line).every(Number.isFinite)).toBe(true);
    expect(coords(area).every(Number.isFinite)).toBe(true);
  });

  it("closes the area path back along the bottom edge", () => {
    // The wash has to be a closed shape or the gradient fills unpredictably.
    const { area } = tracePaths([1, 2, 3]);
    expect(area.endsWith("Z")).toBe(true);
    // Returns to the bottom-left corner. Derived from the path itself rather than
    // hardcoding the viewBox height, which would break silently on a resize.
    const h = Number(area.match(/L(\d+) (\d+) Z$/)?.[2]);
    expect(area).toMatch(new RegExp(`L0 ${h} Z$`));
  });

  it("keeps the trace inside the viewBox for a volatile series", () => {
    // Padding exists so the halo isn't clipped; the trace must stay within it.
    const { line } = tracePaths([100, 90000, 500, 70000, 200]);
    // Bounds come from the area path's closing corner, so this keeps holding if the
    // viewBox height changes.
    const { area } = tracePaths([100, 90000, 500, 70000, 200]);
    const H = Number(area.match(/L0 (\d+) Z$/)?.[1]);
    const PAD = 6;
    const ys = coords(line).filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(PAD);
    expect(Math.max(...ys)).toBeLessThanOrEqual(H - PAD);
  });
});

describe("formatChange", () => {
  it("shows two decimals for ordinary moves", () => {
    expect(formatChange(0.712)).toBe("0.71%");
    expect(formatChange(-45.138)).toBe("45.14%"); // sign is rendered separately
  });

  it("switches to a multiple past 4 digits", () => {
    // "all" spans 2010's ~$0.09 to today: ~75,000,000%, which reads as a rendering
    // fault and blows out the row. 75117560.76% => 751,177x.
    expect(formatChange(75_117_560.76)).toBe("751,177×");
  });

  it("keeps percent right below the threshold", () => {
    expect(formatChange(9_999)).toBe("9999.00%");
    expect(formatChange(10_000)).toContain("×");
  });
});

describe("formatScrubTime", () => {
  // Fixed instant so the assertions don't drift: 2026-03-04T15:45:00Z.
  const t = Math.floor(Date.UTC(2026, 2, 4, 15, 45) / 1000);

  it("shows a clock time on 24h, where hour-level detail is meaningful", () => {
    // Locale-dependent formatting, so assert the shape rather than exact text.
    expect(formatScrubTime(t, "24h")).toMatch(/\d{1,2}:\d{2}/);
  });

  it("shows a day on 7d and 30d", () => {
    for (const r of ["7d", "30d"] as const) {
      const s = formatScrubTime(t, r);
      expect(s).toMatch(/\d{1,2}/);
      expect(s).not.toMatch(/:/); // no clock time — meaningless at this zoom
    }
  });

  it("shows a month and year on long ranges", () => {
    for (const r of ["1y", "all"] as const) {
      expect(formatScrubTime(t, r)).toMatch(/20\d{2}/);
    }
  });
});

describe("tracePaths — uneven time spacing", () => {
  // Real shape of the upstream series: weekly before 2013, daily until late 2023,
  // hourly after. Plotting by array index crushed 2010-2023 into the leftmost ~3% of
  // the width, so a genuine early rally rendered as a vertical spike at the far left.
  const HOUR = 3600;
  const WEEK = 7 * 24 * HOUR;

  /** 10 weekly points then 100 hourly ones — dense tail, sparse head. */
  function unevenSeries() {
    const times: number[] = [];
    let t = 0;
    for (let i = 0; i < 10; i++) {
      times.push(t);
      t += WEEK;
    }
    for (let i = 0; i < 100; i++) {
      times.push(t);
      t += HOUR;
    }
    return { times, points: times.map((_, i) => 100 + i) };
  }

  function xs(line: string): number[] {
    return (line.match(/[ML](-?\d+(\.\d+)?) /g) ?? []).map((m) => Number(m.slice(1)));
  }

  it("spreads the sparse head across most of the width when given times", () => {
    const { times, points } = unevenSeries();
    const xTime = xs(tracePaths(points, times).line);
    // The 10 weekly points span ~9 weeks of a ~13-week series, so they should occupy
    // the majority of the width — not a sliver.
    expect(xTime[9]).toBeGreaterThan(200); // of 300
  });

  it("REGRESSION: index spacing crushes that same head into a sliver", () => {
    // What the bug looked like. 10 of 110 points => ~2.5% of the width, regardless of
    // the 9 weeks they actually cover.
    const { times, points } = unevenSeries();
    const xIndex = xs(tracePaths(points).line);
    expect(xIndex[9]).toBeLessThan(30);
    // And the fix genuinely differs — guards against `times` being ignored.
    const xTime = xs(tracePaths(points, times).line);
    expect(xTime[9]).toBeGreaterThan(xIndex[9] * 5);
  });

  it("still spans the full width, first to last", () => {
    const { times, points } = unevenSeries();
    const x = xs(tracePaths(points, times).line);
    expect(x[0]).toBe(0);
    expect(x[x.length - 1]).toBe(300);
  });

  it("falls back to index spacing when timestamps are all identical", () => {
    // A zero time span would divide by zero; index spacing is the safe fallback.
    const points = [1, 2, 3];
    const { line } = tracePaths(points, [5, 5, 5]);
    expect(xs(line)).toEqual([0, 150, 300]);
  });

  it("produces no NaN for a mismatched/short times array", () => {
    // Defensive: a times array shorter than points would read undefined mid-series.
    const { line } = tracePaths([1, 2, 3], [0, 100, 200]);
    expect((line.match(/-?\d+(\.\d+)?/g) ?? []).map(Number).every(Number.isFinite)).toBe(true);
  });
});
