// Per-glyph timing for the telemetry "strike" (theme.css: .telemetry-digit,
// balance-strike.ts). Framework-free on purpose: balance-strike.ts imports the
// bound below and is itself imported by tests that run DOM-less and React-less
// — pulling this through ui.tsx would drag React and its transitive
// icon-library imports into them.

const DELAY_MOD_MS = 190; // delay range: 0..DELAY_MOD_MS - 1
const DURATION_BASE_MS = 620;
const DURATION_STEPS = 5; // duration range: DURATION_BASE_MS + (0..DURATION_STEPS-1) * DURATION_STEP_MS
const DURATION_STEP_MS = 90;

/**
 * Deterministic per-glyph warm-up timing, keyed by the glyph's position
 * rather than random: a re-render mid-animation can't re-roll a digit's beat
 * and restart it, and the pattern is reproducible when tuning it. The two
 * primes give a long-period, non-obvious sequence — no two adjacent digits
 * share a beat, and the figure lights raggedly rather than left-to-right.
 */
export function digitCycle(index: number): { delay: number; duration: number } {
  return {
    delay: (index * 37) % DELAY_MOD_MS,
    duration: DURATION_BASE_MS + ((index * 53) % DURATION_STEPS) * DURATION_STEP_MS,
  };
}

/** Longest any single digit's strike can run: the largest delay plus the
 *  largest duration `digitCycle` can produce. The one source other code
 *  derives a "the whole figure is done" bound from, so retuning the constants
 *  above can't silently desync it. */
export const MAX_DIGIT_STRIKE_MS =
  DELAY_MOD_MS - 1 + (DURATION_BASE_MS + (DURATION_STEPS - 1) * DURATION_STEP_MS);
