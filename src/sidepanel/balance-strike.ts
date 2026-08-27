// The balance "strike" decision state machine — whether the numerals currently
// on screen deserve a neon warm-up (see .telemetry-digit in theme.css, and
// balance-warmup.ts for the hook that renders it). Framework-free on purpose
// (the digit-cycle.ts move, one step further): the rules are worth pinning
// with tests, and keeping them out of the React module lets the tests import
// them plainly — no react mock, no __shouldStrike seam.
//
// It plays at three moments:
//
//   1. the first real figure after an unlock,
//   2. when a figure that was still settling becomes final, or a final figure
//      changes — a received amount confirming, a send landing, and
//   3. when the user presses Sync, whether or not the figure moved.
//
// Rule 3 still defers to the "not while settling" gate: an unconfirmed tx is
// already pulsing the whole hero, and striking a figure that isn't final yet
// would claim it is. That balance gets its strike at rule 2's moment instead.
//
// State lives at module scope, not in component state, because the hero unmounts
// every time you visit Receive/Send/Settings: component state would replay the
// flicker on every return home. Lifetime is the panel document, so reopening the
// panel plays it again, and a lock re-arms it explicitly.

import { MAX_DIGIT_STRIKE_MS } from "@/sidepanel/digit-cycle";

/** Longest a strike can run, with margin — derived from digitCycle's actual
 *  range rather than a hand-copied number, so retuning it can't silently
 *  desync this. Both the visible flag in the hook and the decision memo below
 *  expire on this window. */
export const STRIKE_MS = MAX_DIGIT_STRIKE_MS + 100;

let armed = true;
let lastUnconfirmed = false;
let lastSats: string | null = null;
// Memo of the last decision, so repeat calls for the SAME state within one
// short window are idempotent — StrictMode invokes effects twice in
// development, and a denomination toggle re-runs them with the same
// underlying balance. Expires after STRIKE_MS (below) rather than only on
// re-arm: without that expiry, a component that unmounts and remounts with an
// unchanged (sats, unconfirmed) would read a stale decision forever and
// replay an animation that already finished. `armed`, `lastUnconfirmed` and
// `lastSats` are NOT expired here: they're the actual state machine that
// detects the next real change, and have to persist indefinitely for that to
// work.
//
// Since cancelBalanceStrike() arrived, losing the memo early is no longer
// harmless — it decides whether a toggle stops a flicker. So a memo carries
// its generation (`seq`): restrike and cancel both null it and let the SAME
// key be re-derived, and each fresh computation schedules another expiry
// timer. Matching on key alone would let an earlier generation's still-ticking
// timer clear a newer, live decision for the very figure it once decided.
let memo: { key: string; strike: boolean; seq: number } | null = null;
let memoSeq = 0;

// Arming is imperative — a lock, or the user pressing Sync — but the strike is
// decided per render from the balance, so a re-arm that leaves the figure
// unchanged (Sync when nothing moved) has to nudge the hook as well as flip
// the flag.
//
// Only the manual sync may nudge, which is why arming is two exported functions
// rather than one with a flag: the lock paths call armBalanceStrike() while the
// hero is STILL mounted (the panel is on screen until `state.locked` flips), and
// a notification there forces a re-render that re-runs the effect and consumes
// the arming on the locking screen — leaving nothing for the next unlock, the
// one moment rule 1 exists for. armBalanceStrike() is silent for exactly that
// reason; restrikeBalance() is the one that talks.
let armVersion = 0;
const listeners = new Set<() => void>();

/** Subscribe to re-arms. Used by the hook (balance-warmup.ts) as its
 *  useSyncExternalStore source; the subscription itself is what lets a manual
 *  sync re-decide an unchanged figure. */
export function subscribeToArming(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** The arm version — a snapshot that changes on every notifying re-arm. */
export function getArmVersion(): number {
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

/** Drop any live strike so what shows next is static — the denomination
 *  toggle's path. A reshaped figure mid-flicker is the worst of both worlds
 *  (reconciled glyph spans mix reused animation progress with fresh mounts
 *  around the new digit string), and relighting on every unit swap read as
 *  noise; a toggle kills an in-flight flicker outright instead. Only strikes
 *  actually playing or still within their latch window count — during the
 *  stars/settling phases nothing is playing, so cancel leaves without a
 *  sound. `armed`, `lastSats`, `lastUnconfirmed` are deliberately untouched:
 *  nothing about the underlying balance changed, so the arming meant for the
 *  numerals' arrival survives regardless (rule 1) and so does the history a
 *  real change later still strikes on. What a no-op avoids is only the
 *  spurious arm bump. The bump reruns the hook's decision effect, whose fresh
 *  `shouldStrike` reads false and drops the epoch — rendering plain numerals
 *  immediately. */
export function cancelBalanceStrike(): void {
  if (!memo?.strike) return; // idle: nothing is playing, nothing to stop
  memo = null;
  armVersion += 1;
  for (const listener of listeners) listener();
}

/**
 * Whether this balance state deserves a strike. Keyed on the underlying sats
 * rather than the rendered string, so cycling sats → L-BTC → fiat does not
 * count as the balance changing.
 */
export function shouldStrike(sats: string, unconfirmed: boolean): boolean {
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
  const seq = ++memoSeq;
  memo = { key, strike, seq };
  // Only ever one live timer per fresh computation: a repeat call for the
  // same key returns early above without scheduling another. The guard is on
  // GENERATION, not on the key: an earlier generation's timer must not clear
  // a newer decision just because it landed on the same figure — that's the
  // toggle → sync → toggle sequence cancelBalanceStrike exists to handle.
  //
  // While the document is hidden the expiry DEFERS, matching the visible-time
  // deadline the hook clears on: the animations are paused, so the strike the
  // memo decided is still playing, and letting the memo lapse would make a
  // remount in the tail (Receive and back) read `false` and yank the glow
  // mid-flicker. One full window per re-check bounds the LATE side only — the
  // tail can never exceed STRIKE_MS past an unhide. The hops run on wall clock
  // while hidden while the hook tracks exact visible time, so shortly after an
  // unhide this CAN lapse up to a window early; the worst case of that drift
  // is a toggle in the sliver no-op'ing (the pre-cancel behavior), never a
  // strike stuck on. `document` is guarded for the test environment, where
  // this module runs DOM-less.
  const expire = () => {
    if (typeof document !== "undefined" && document.hidden) {
      setTimeout(expire, STRIKE_MS);
      return;
    }
    if (memo?.seq === seq) memo = null;
  };
  setTimeout(expire, STRIKE_MS);
  return strike;
}
