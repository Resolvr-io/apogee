// The balance "strike" — numerals coming on like a neon tube (see
// .telemetry-digit in theme.css). It plays at three moments:
//
//   1. the first real figure after an unlock,
//   2. when a figure that was still settling becomes final, or a final figure
//      changes — a received amount confirming, a send landing, and
//   3. when the user presses Sync, whether or not the figure moved.
//
// Rule 3 still defers to the "not while settling" gate below: an unconfirmed tx
// is already pulsing the whole hero, and striking a figure that isn't final yet
// would claim it is. That balance gets its strike at rule 2's moment instead.
//
// State lives at module scope, not in component state, because the hero unmounts
// every time you visit Receive/Send/Settings: component state would replay the
// flicker on every return home. Lifetime is the panel document, so reopening the
// panel plays it again (those numerals really are lighting up for the first time
// in that view), and a lock re-arms it explicitly.

import { useEffect, useState, useSyncExternalStore } from "react";
import { MAX_DIGIT_STRIKE_MS } from "@/sidepanel/digit-cycle";

/** Longest a strike can run, with margin — derived from digitCycle's actual
 *  range rather than a hand-copied number, so retuning it can't silently
 *  desync this. Both the visible flag and the decision memo below expire on
 *  this window. */
const STRIKE_MS = MAX_DIGIT_STRIKE_MS + 100;

let armed = true;
let lastUnconfirmed = false;
let lastSats: string | null = null;
// Memo of the last decision, so repeat calls for the SAME state within one
// short window are idempotent — StrictMode invokes effects twice in
// development, and a denomination toggle re-runs them with the same
// underlying balance. Expires after STRIKE_MS (below) rather than only on
// armBalanceStrike(): without that expiry, a component that unmounts and
// remounts with an unchanged (sats, unconfirmed) — returning from the
// step-up screen, which unmounts Wallet — would read this stale decision
// forever and replay an animation that already finished. `armed`,
// `lastUnconfirmed` and `lastSats` are NOT expired here: they're the actual
// state machine that detects the next real change, and have to persist
// indefinitely for that to work.
let memo: { key: string; strike: boolean } | null = null;

// Arming is imperative — a lock, or the user pressing Sync — but the strike is
// decided in an effect keyed on the balance. A manual sync that leaves the figure
// unchanged changes nothing in that effect's deps, so it has to nudge the hook as
// well as flip the flag.
//
// Only the manual sync may nudge, which is why arming is two exported functions
// rather than one with a flag: the lock paths call armBalanceStrike() while the
// hero is STILL mounted (the panel is on screen until `state.locked` flips), and
// a notification there forces a re-render that re-runs the effect and consumes
// the arming on the locking screen — leaving nothing for the next unlock, the
// one moment rule 1 exists for. armBalanceStrike() is silent for exactly that
// reason; restrikeBalance() is the one that talks.
//
// The counter behind the nudge lives here at module scope with the rest of the
// state machine rather than in the component: component state resets to 0 on the
// remount the step-up screen causes, and a reset reads as a change — which would
// replay a finished animation on every return, the exact failure this file is
// otherwise built to avoid.
let armVersion = 0;
const listeners = new Set<() => void>();

function subscribeToArming(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getArmVersion(): number {
  return armVersion;
}

function arm(notify: boolean): void {
  armed = true;
  lastUnconfirmed = false;
  lastSats = null;
  memo = null;
  if (!notify) return;
  armVersion += 1;
  for (const listener of listeners) listener();
}

/** Re-arm, so the next balance shown strikes again. Called on lock — the hero
 *  unmounts and remounts around it, so no live hook needs telling. */
export function armBalanceStrike(): void {
  arm(false);
}

/** Re-arm AND nudge a mounted hero, so its figure re-strikes even unchanged —
 *  the manual sync (see Wallet's `refresh`). */
export function restrikeBalance(): void {
  arm(true);
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
  // Only ever one live timer per fresh computation: a repeat call for the
  // same key returns early above without scheduling another. The guard
  // checks the memo still names THIS key before clearing it, so an unrelated
  // later write (a different key) can't have its memo clobbered by an
  // earlier key's stale expiry.
  setTimeout(() => {
    if (memo?.key === key) memo = null;
  }, STRIKE_MS);
  return strike;
}

/** Test seam: the decision is the part worth pinning, and it can't be reached
 *  through the hook without a renderer. Not for production callers. */
export const __shouldStrike = shouldStrike;

/**
 * The strike epoch: 0 while idle, otherwise a counter that increments per
 * strike. An epoch rather than a boolean so a re-strike while a strike is still
 * playing can actually replay — the glyph spans are only mounted fresh on the
 * warmup false→true edge, so a boolean would coalesce invisibly into the
 * running animation. Callers pass `warmup = epoch > 0` and key the rendered
 * figure by the epoch.
 *
 * Decided in an effect rather than during render: StrictMode double-invokes
 * render in development, so consuming the one-shot there would hand `false` to
 * the pass that actually commits — the flicker would work in production and
 * silently never play in `pnpm dev`.
 *
 * Pass `ready: false` while the figure is stars, a spinner or a dash; otherwise
 * those consume the arming and the numerals arrive already lit.
 */
export function useBalanceStrike(sats: string, unconfirmed: boolean, ready: boolean): number {
  // In the deps below only to re-run the decision after an imperative re-arm.
  // The value itself is never read: what strikes or doesn't is entirely
  // shouldStrike's business, so a spurious bump costs a no-op effect pass.
  const arming = useSyncExternalStore(subscribeToArming, getArmVersion);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    // Both early-return paths must clear a strike from a PRIOR run explicitly:
    // the timeout below only fires on the run that set it, so a deps change
    // landing here mid-strike (cleanup already killed that timeout) would
    // otherwise leave the epoch latched above 0 forever — and since it never
    // returns to 0→n, no future real strike could replay either.
    if (!ready || !shouldStrike(sats, unconfirmed)) {
      setEpoch(0);
      return;
    }
    setEpoch((e) => e + 1);
    const t = window.setTimeout(() => setEpoch(0), STRIKE_MS);
    return () => window.clearTimeout(t);
  }, [sats, unconfirmed, ready, arming]);
  return epoch;
}
