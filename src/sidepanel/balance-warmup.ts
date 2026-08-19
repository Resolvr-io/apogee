// One-shot arming for the balance warm-up flicker (the numerals "turning on"
// like a neon sign, see .telemetry-digit in theme.css).
//
// Module scope rather than component state on purpose: the hero unmounts every
// time you visit Receive/Send/Settings and come back, so component state would
// replay the flicker on every return home — it's meant to be the moment the
// display comes to life, not a transition.
//
// Lifetime is the PANEL document: reopening the side panel plays it again, which
// is right — those numerals really are lighting up for the first time in that
// view. A lock re-arms it explicitly (see App.tsx), so lock → unlock inside one
// panel session plays it too.

let armed = true;

/** True exactly once per arming. Call while rendering a real balance figure. */
export function takeBalanceWarmup(): boolean {
  if (!armed) return false;
  armed = false;
  return true;
}

/** Re-arm, so the next balance shown plays the warm-up again. Called on lock. */
export function armBalanceWarmup(): void {
  armed = true;
}
