// The balance "strike" decision state machine — whether the numerals on screen
// deserve a neon warm-up (see .telemetry-digit in theme.css, and
// balance-warmup.ts for the hook that renders it). Framework-free on purpose, so
// the rules can be pinned with plain tests: no react mock, no __shouldStrike
// seam.
//
// It plays at three moments:
//
//   1. the first real figure after an unlock,
//   2. when a settling figure becomes final, or a final figure changes — a
//      received amount confirming, a send landing, and
//   3. when the user presses Sync, whether or not the figure moved.
//
// Rule 3 still defers to the "not while settling" gate: an unconfirmed tx is
// already pulsing the whole hero, and striking a figure that isn't final would
// claim it is. That balance gets its strike at rule 2's moment instead.
//
// State lives at module scope because the hero unmounts on every visit to
// Receive/Send/Settings, and component state would replay the flicker on every
// return home. Lifetime is the panel document, so reopening plays it again.

import { MAX_DIGIT_STRIKE_MS } from "@/sidepanel/digit-cycle";

/** Longest a strike can run, with margin — derived from digitCycle's own range
 *  rather than hand-copied, so retuning it can't silently desync this. */
export const STRIKE_MS = MAX_DIGIT_STRIKE_MS + 100;

let armed = true;
let lastUnconfirmed = false;
let lastSats: string | null = null;
// Memo of the last decision, so repeat calls for the SAME state within one short
// window are idempotent — StrictMode invokes effects twice, and a denomination
// toggle re-runs them against the same balance. It expires rather than living
// until the next re-arm: a component that unmounts and remounts unchanged would
// otherwise read a stale decision forever and replay a finished animation.
// `armed`, `lastUnconfirmed` and `lastSats` are NOT expired — they are the state
// machine that detects the next real change, and must persist.
//
// The memo carries its generation (`seq`) because losing it early is no longer
// harmless: it decides whether a toggle stops a flicker. Restrike and cancel both
// null it and let the same key be re-derived, each scheduling a fresh expiry.
// Matching on key alone would let an earlier generation's still-ticking timer
// clear a newer, live decision for the very figure it once decided.
let memo: { key: string; strike: boolean; seq: number } | null = null;
let memoSeq = 0;

// Arming is imperative — a lock, or Sync — but the strike is decided per render
// from the balance, so a re-arm leaving the figure unchanged (Sync when nothing
// moved) has to nudge the hook as well as flip the flag.
//
// Only the manual sync may nudge, which is why this is two exported functions
// rather than one with a flag: the lock paths arm while the hero is STILL
// mounted, and a notification there would force a re-render that consumes the
// arming on the locking screen — leaving nothing for the next unlock, the one
// moment rule 1 exists for.
let armVersion = 0;
const listeners = new Set<() => void>();

/** Subscribe to re-arms — the hook's useSyncExternalStore source. The
 *  subscription is what lets a manual sync re-decide an unchanged figure. */
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

/** Drop any live strike so what shows next is static — the denomination toggle's
 *  path. A reshaped figure mid-flicker is the worst of both worlds, since
 *  reconciled glyph spans mix reused animation progress with fresh mounts around
 *  the new digit string, and relighting on every unit swap read as noise.
 *
 *  `armed`, `lastSats` and `lastUnconfirmed` are deliberately untouched: nothing
 *  about the underlying balance changed, so rule 1's arming survives and so does
 *  the history a later real change strikes on. The early return only avoids a
 *  spurious arm bump; the bump itself reruns the hook's decision effect, whose
 *  fresh `shouldStrike` reads false and drops the epoch. */
export function cancelBalanceStrike(): void {
  if (!memo?.strike) return; // idle: nothing is playing, nothing to stop
  memo = null;
  armVersion += 1;
  for (const listener of listeners) listener();
}

/**
 * Whether this balance state deserves a strike. Keyed on the underlying sats
 * rather than the rendered string, so cycling sats → L-BTC → fiat does not count
 * as the balance changing.
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
      // One final figure to another without us seeing the pending phase (a sync
      // that picked up an already-confirmed transaction).
      strike = true;
    }
  }

  lastUnconfirmed = unconfirmed;
  lastSats = sats;
  const seq = ++memoSeq;
  memo = { key, strike, seq };
  // One live timer per fresh computation — a repeat call for the same key
  // returns early above. The guard is on GENERATION, not key: an earlier
  // generation's timer must not clear a newer decision just because it landed on
  // the same figure, which is the toggle → sync → toggle sequence.
  //
  // While the document is hidden the expiry DEFERS, matching the visible-time
  // deadline the hook clears on: animations are paused, so the strike is still
  // playing, and letting the memo lapse would make a remount in the tail read
  // `false` and yank the glow mid-flicker. Deferring by a full window bounds the
  // LATE side only. The hops run on wall clock while the hook tracks visible
  // time, so shortly after an unhide this can lapse up to a window EARLY; the
  // worst case is a toggle in that sliver no-op'ing, never a strike stuck on.
  // `document` is guarded for the DOM-less test environment.
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
