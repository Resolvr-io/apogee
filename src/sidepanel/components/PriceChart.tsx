// BTC price trace — a phosphor readout, not a finance chart.
//
// Hand-rolled SVG: no charting library, matching the rest of the panel. There are no
// axes, gridlines or tick labels — the trace shows shape and direction, and the exact
// figures are read from the readout beneath it or by scrubbing. That absence is what
// keeps this small: axis scales and tick generation are what usually force a library in.
//
// The look is a trace on a CRT: a thin phosphor-blue line over a faint gradient wash,
// with the line drawn twice — a wide, heavily-blurred pass underneath for the halo and
// a crisp pass on top — which is the geometry equivalent of `.telemetry-glow`'s
// layered text-shadow.
//
// Switching range doesn't cut: the incoming trace is revealed left-to-right behind a
// sweeping scan line, like a scope repainting. The engine caches every range in one
// series, so a switch resolves instantly and the sweep is the only thing you see.

import { useEffect, useRef, useState } from "react";
import type { PriceHistory, PriceRange } from "@/engine/protocol";
import { TelemetryNumber } from "@/sidepanel/components/ui";
import { cn } from "@/lib/utils";

/** Ranges the chart offers, in display order. Labels are terse like console readouts. */
export const PRICE_RANGES: ReadonlyArray<{ range: PriceRange; label: string }> = [
  { range: "24h", label: "24H" },
  { range: "7d", label: "7D" },
  { range: "30d", label: "30D" },
  { range: "1y", label: "1Y" },
  { range: "all", label: "ALL" },
];

// viewBox units. The trace is drawn to this box and stretched by CSS
// (preserveAspectRatio="none"), so stroke widths use vector-effect to stay hairline.
const W = 300;
const H = 96;
const PAD_T = 6; // keeps the glow off the top edge
const PAD_B = 6;

/** Sweep duration. Long enough to read as a deliberate repaint, short enough that
 *  clicking through ranges never feels gated behind an animation. */
const SWEEP_MS = 460;

/** Build the line path and the closed area path beneath it. Exported for tests:
 *  the normalization is where a flat or single-point series would produce NaN
 *  coordinates and silently render nothing.
 *
 *  `times` positions each point on the x axis. Passing it matters because the
 *  upstream series is NOT evenly spaced — resolution is weekly before 2013, daily
 *  until late 2023, hourly after. Plotting by array index instead crushed 2010–2023
 *  into the leftmost 3% of the width, so a real early rally rendered as a vertical
 *  spike at the left edge. Omit `times` only for a series known to be even. */
export function tracePaths(
  points: number[],
  times?: number[],
): { line: string; area: string } {
  const min = Math.min(...points);
  const max = Math.max(...points);
  // A flat series (or a single repeated value) would divide by zero; render it as a
  // centered horizontal line rather than NaN coordinates.
  const span = max - min || 1;

  // Time-proportional x when timestamps are supplied and actually span a range;
  // otherwise fall back to index spacing.
  const t0 = times?.[0];
  const tN = times?.[times.length - 1];
  const tSpan = t0 != null && tN != null ? tN - t0 : 0;
  const x = (i: number) => {
    if (points.length === 1) return W / 2;
    if (times && tSpan > 0) return ((times[i] - t0!) / tSpan) * W;
    return (i / (points.length - 1)) * W;
  };
  const y = (v: number) => PAD_T + (1 - (v - min) / span) * (H - PAD_T - PAD_B);

  const line = points
    .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ");
  return { line, area: `${line} L${W} ${H} L0 ${H} Z` };
}

/** Percent change for display. Over "all" the move from 2010's ~$0.09 is
 *  ~75,000,000% — arithmetically right, but a number that long reads as a rendering
 *  fault and blows out the row, so past 4 digits switch to a multiple. */
export function formatChange(pct: number): string {
  return Math.abs(pct) >= 10_000
    ? `${(Math.abs(pct) / 100 + 1).toLocaleString("en-US", { maximumFractionDigits: 0 })}×`
    : `${Math.abs(pct).toFixed(2)}%`;
}

/** Label for the scrubbed point. Short ranges want a time, long ranges a date — a
 *  timestamp to the minute is meaningless across a year of hourly closes. */
export function formatScrubTime(unixSeconds: number, range: PriceRange): string {
  const d = new Date(unixSeconds * 1000);
  if (range === "24h") {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (range === "7d" || range === "30d") {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export function PriceChart({
  history,
  range,
  onRangeChange,
  formatPrice,
}: {
  history: PriceHistory;
  range: PriceRange;
  onRangeChange: (r: PriceRange) => void;
  /** Formats a price into the caller's fiat convention, so the chart doesn't need
   *  its own currency logic (the panel already has `formatFiat`). */
  formatPrice: (v: number) => string;
}) {
  const points = history.points;
  const { line, area } = tracePaths(points, history.times);
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const first = points[0];
  const last = points[points.length - 1];
  // Guard a zero first point (the engine filters non-positive values, but the
  // division shouldn't depend on that).
  const pct = first > 0 ? ((last - first) / first) * 100 : 0;
  const up = pct >= 0;

  // ---- sweep on range change ------------------------------------------------
  //
  // A clip rect animated 0 → full width reveals the new trace instead of swapping it.
  // Keyed on the range so ordinary re-renders (a hover, a refreshed series) don't
  // re-trigger it — only an actual range change repaints.
  const [sweeping, setSweeping] = useState(false);
  const prevRange = useRef(range);
  useEffect(() => {
    if (prevRange.current === range) return;
    prevRange.current = range;
    setSweeping(true);
    const id = window.setTimeout(() => setSweeping(false), SWEEP_MS);
    return () => window.clearTimeout(id);
  }, [range]);

  // ---- hover scrub ----------------------------------------------------------
  //
  // Index under the pointer, or null when not hovering. Derived from the pointer's
  // fraction across the element rather than from SVG coordinates, so it stays correct
  // under `preserveAspectRatio="none"` stretching.
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const scrubbing = scrubIndex != null && scrubIndex >= 0 && scrubIndex < points.length;
  const scrubValue = scrubbing ? points[scrubIndex] : null;

  // The x axis is TIME, not index (see tracePaths), so the pointer's fraction across
  // the element maps to a timestamp — then to the nearest point at that time. Mapping
  // straight to an index would land on the wrong point wherever the upstream
  // resolution changes: on "all", index 8% is 2013 while time 8% is ~2011.
  const times = history.times;
  const tFirst = times[0];
  const tLast = times[times.length - 1];

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || points.length < 2) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const span = tLast - tFirst;
    if (span <= 0) {
      setScrubIndex(Math.round(frac * (points.length - 1)));
      return;
    }
    const target = tFirst + frac * span;
    // Binary search for the closest timestamp — the series runs to ~24k points, so a
    // linear scan on every pointer move would be wasteful.
    let lo2 = 0;
    let hi2 = times.length - 1;
    while (hi2 - lo2 > 1) {
      const mid = (lo2 + hi2) >> 1;
      if (times[mid] <= target) lo2 = mid;
      else hi2 = mid;
    }
    setScrubIndex(target - times[lo2] <= times[hi2] - target ? lo2 : hi2);
  }

  // Marker geometry, in viewBox units. The label is positioned separately as a
  // percentage so its text renders crisp in the DOM rather than stretched in the SVG.
  // Fraction comes from the point's TIME so the marker sits exactly on the trace.
  const scrubFrac =
    scrubbing && tLast > tFirst ? (times[scrubIndex] - tFirst) / (tLast - tFirst) : 0;
  const scrubXUnits = scrubFrac * W;
  const scrubYUnits = (() => {
    if (!scrubbing || scrubValue == null) return 0;
    const span = hi - lo || 1;
    return PAD_T + (1 - (scrubValue - lo) / span) * (H - PAD_T - PAD_B);
  })();
  // The selected point's own timestamp — exact, rather than interpolated from the
  // window (which would be wrong wherever the resolution changes).
  const scrubTime = scrubbing ? times[scrubIndex] : null;
  const showScrub = scrubbing && scrubValue != null && !sweeping;

  return (
    <div className="flex flex-col gap-3">
      {/* Range selector. Spaced rather than segmented — no pills or dividers, so it
          reads as a row of console labels floating under the trace. */}
      <div className="flex items-center justify-center gap-4">
        {PRICE_RANGES.map(({ range: r, label }) => (
          <button
            key={r}
            type="button"
            onClick={() => onRangeChange(r)}
            aria-pressed={r === range}
            className={cn(
              "font-telemetry text-[10px] uppercase tracking-[0.18em] transition-colors",
              r === range
                ? "text-[color:var(--accent-strong)]"
                : "text-[color:var(--text-subtle)] hover:text-[color:var(--text-secondary)]",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Full-bleed: negative margins cancel the balance frame's px-4 (16px) so the
          trace spans the whole panel width, which is what makes it read as an
          instrument readout rather than a widget sitting inside a card.
          `touch-none` keeps a drag-scrub from scrolling the panel instead. */}
      <div
        className="relative -mx-4 touch-none"
        onPointerMove={onPointerMove}
        onPointerLeave={() => setScrubIndex(null)}
        onPointerCancel={() => setScrubIndex(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-24 w-full"
          role="img"
          aria-label={`Bitcoin price, ${range}: ${up ? "up" : "down"} ${formatChange(pct)}`}
        >
          <defs>
            {/* Wash under the trace, fading to nothing well above the bottom edge so
                it never reads as a solid block. */}
            <linearGradient id="apogee-trace-wash" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.26" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
            {/* The halo. stdDeviation is in viewBox units; the box is stretched
                horizontally by CSS, so the blur reads wider than tall — which is how
                a phosphor bloom behaves along a scan line. */}
            <filter id="apogee-trace-halo" x="-10%" y="-30%" width="120%" height="160%">
              <feGaussianBlur stdDeviation="2.2" />
            </filter>
            {/* Reveal window for the sweep. Animating the rect's WIDTH (rather than
                fading opacity) is what produces the left-to-right repaint. `key`
                forces a fresh element per range so the animation restarts. */}
            <clipPath id="apogee-trace-reveal">
              {sweeping ? (
                <rect key={range} x="0" y="0" height={H} width="0">
                  <animate
                    attributeName="width"
                    from="0"
                    to={W}
                    dur={`${SWEEP_MS}ms`}
                    fill="freeze"
                  />
                </rect>
              ) : (
                <rect x="0" y="0" height={H} width={W} />
              )}
            </clipPath>
          </defs>

          <g clipPath="url(#apogee-trace-reveal)">
            <path d={area} fill="url(#apogee-trace-wash)" />
            <path
              d={line}
              fill="none"
              stroke="var(--telemetry-halo, var(--accent))"
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity="0.55"
              filter="url(#apogee-trace-halo)"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={line}
              fill="none"
              stroke="var(--telemetry-fg)"
              strokeWidth="1.25"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>

          {/* Leading edge of the sweep — a bright scan line running ahead of the
              reveal, fading out as it reaches the end. */}
          {sweeping && (
            <line
              key={`scan-${range}`}
              x1="0"
              y1="0"
              x2="0"
              y2={H}
              stroke="var(--telemetry-fg)"
              strokeWidth="1"
              opacity="0.75"
              vectorEffect="non-scaling-stroke"
            >
              <animate attributeName="x1" from="0" to={W} dur={`${SWEEP_MS}ms`} fill="freeze" />
              <animate attributeName="x2" from="0" to={W} dur={`${SWEEP_MS}ms`} fill="freeze" />
              <animate
                attributeName="opacity"
                from="0.75"
                to="0"
                dur={`${SWEEP_MS}ms`}
                fill="freeze"
              />
            </line>
          )}

          {/* Scrub marker: a thin vertical rule plus a dot on the trace. Inside the
              SVG so it tracks the stretched geometry exactly. */}
          {showScrub && (
            <g>
              <line
                x1={scrubXUnits}
                y1="0"
                x2={scrubXUnits}
                y2={H}
                stroke="var(--telemetry-fg)"
                strokeWidth="0.75"
                opacity="0.45"
                vectorEffect="non-scaling-stroke"
              />
              {/* Drawn as a ring rather than a filled circle: the viewBox stretch
                  would squash a disc into an ellipse, but a hairline stroke stays
                  round under vector-effect. */}
              <circle
                cx={scrubXUnits}
                cy={scrubYUnits}
                r="1.6"
                fill="var(--surface-card)"
                stroke="var(--telemetry-fg)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )}
        </svg>

        {/* Scrubbed value, tracking the cursor.
            `whitespace-nowrap` is load-bearing: TelemetryNumber emits each digit as a
            separate node (and wraps "1" in an inline-block for alignment), so the
            price has a break opportunity between every character and wrapped
            mid-number — "$64,691" over "00" — inside this narrow absolute box.
            The backdrop panel is for legibility: the label sits over the trace and its
            glow, and phosphor-on-phosphor was unreadable where the two overlapped. */}
        {showScrub && (
          <div
            className={cn(
              "pointer-events-none absolute flex -translate-x-1/2 flex-col items-center gap-0.5 whitespace-nowrap rounded-md bg-[color:color-mix(in_srgb,var(--surface-card)_82%,transparent)] px-2 py-1 backdrop-blur-[2px]",
              // Sit opposite the trace: when the scrubbed point is high in the window
              // the label would land on the line, so drop it to the bottom instead.
              scrubYUnits < H / 2 ? "bottom-1" : "top-1",
            )}
            style={{ left: `${Math.min(84, Math.max(16, scrubFrac * 100))}%` }}
          >
            <TelemetryNumber
              value={formatPrice(scrubValue)}
              className="whitespace-nowrap text-xs leading-none"
            />
            {scrubTime != null && (
              <span className="whitespace-nowrap text-[10px] leading-none text-[color:var(--text-subtle)]">
                {formatScrubTime(scrubTime, range)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Window readout — the change across the SELECTED range plus the low/high
          bounding the trace (the bar above owns the live price and 24h delta). No
          rule above it: the trace's own gradient already separates them, and a
          hairline here would re-introduce the boxed look. */}
      <div className="flex items-baseline justify-between gap-2 px-1">
        <span
          className={cn(
            "text-xs tracking-wide",
            up ? "text-[color:var(--accent-mint)]" : "text-[color:var(--accent-amber)]",
          )}
        >
          {up ? "▲" : "▼"} {formatChange(pct)}
        </span>
        <span className="flex items-baseline gap-2 text-[color:var(--text-subtle)]">
          <span className="font-telemetry text-[10px] uppercase tracking-[0.18em]">L</span>
          <TelemetryNumber value={formatPrice(lo)} glow={false} className="text-[11px]" />
          <span className="font-telemetry text-[10px] uppercase tracking-[0.18em]">H</span>
          <TelemetryNumber value={formatPrice(hi)} glow={false} className="text-[11px]" />
        </span>
      </div>
    </div>
  );
}
