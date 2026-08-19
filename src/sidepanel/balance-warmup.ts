// The balance "strike" — numerals coming on like a neon tube (see
// .telemetry-digit in theme.css). It plays at two moments:
//
//   1. the first real figure after an unlock, and
//   2. when a figure that was still settling becomes final, or a final figure
//      changes — a received amount confirming, a send landing.
//
// State lives at module scope, not in component state, because the hero unmounts
// every time you visit Receive/Send/Settings: component state would replay the
// flicker on every return home. Lifetime is the panel document, so reopening the
// panel plays it again (those numerals really are lighting up for the first time
// in that view), and a lock re-arms it explicitly.

import { useEffect, useState } from "react";

/** Longest a strike can run: the biggest delay (190ms) plus the longest duration
 *  (980ms) in digitCycle, rounded up. After this the flag clears, so a later
 *  remount doesn't re-apply a class whose animation has already finished. */
const STRIKE_MS = 1_300;

let armed = true;
let lastUnconfirmed = false;
let lastSats: string | null = null;
// Memo of the last decision, so repeat calls for the same state are idempotent —
// StrictMode invokes effects twice in development, and a denomination toggle
// re-runs them with the same underlying balance.
let memo: { key: string; strike: boolean } | null = null;

/** Re-arm, so the next balance shown strikes again. Called on lock. */
export function armBalanceStrike(): void {
  armed = true;
  lastUnconfirmed = false;
  lastSats = null;
  memo = null;
}

/**
 * Whether this balance state deserves a strike. Keyed on the underlying sats
 * rather than the rendered string, so cycling sats → L-BTC → fiat does not
 * count as the balance changing.
 */
function shouldStrike(sats: string, unconfirmed: boolean): boolean {
  const key = `${sats}:${unconfirmed}`;
  if (memo?.key === key) return memo.strike;

  let strike = false;
  if (!unconfirmed) {
    if (armed) {
      armed = false;
      strike = true;
    } else if (lastUnconfirmed) {
      // Was settling, now final — the confirmation moment.
      strike = true;
    } else if (lastSats !== null && lastSats !== sats) {
      // Went from one final figure to another without us seeing the pending
      // phase (a sync that picked up an already-confirmed transaction).
      strike = true;
    }
  }

  lastUnconfirmed = unconfirmed;
  lastSats = sats;
  memo = { key, strike };
  return strike;
}

/** Test seam: the decision is the part worth pinning, and it can't be reached
 *  through the hook without a renderer. Not for production callers. */
export const __shouldStrike = shouldStrike;

/**
 * True while a strike should be playing. Decided in an effect rather than during
 * render: StrictMode double-invokes render in development, so consuming the
 * one-shot there would hand `false` to the pass that actually commits — the
 * flicker would work in production and silently never play in `pnpm dev`.
 *
 * Pass `ready: false` while the figure is stars, a spinner or a dash; otherwise
 * those consume the arming and the numerals arrive already lit.
 */
export function useBalanceStrike(sats: string, unconfirmed: boolean, ready: boolean): boolean {
  const [strike, setStrike] = useState(false);
  useEffect(() => {
    if (!ready) return;
    if (!shouldStrike(sats, unconfirmed)) return;
    setStrike(true);
    const t = window.setTimeout(() => setStrike(false), STRIKE_MS);
    return () => window.clearTimeout(t);
  }, [sats, unconfirmed, ready]);
  return strike;
}
