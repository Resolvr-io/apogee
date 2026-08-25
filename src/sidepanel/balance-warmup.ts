// The strike's React half: turns the decisions of balance-strike.ts (same
// module family as digit-cycle.ts — pure logic there, rendering here) into a
// per-render epoch the hero can key its numerals by.

import { useEffect, useState, useSyncExternalStore } from "react";
import { STRIKE_MS, getArmVersion, shouldStrike, subscribeToArming } from "@/sidepanel/balance-strike";

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
    // Hidden-time correction: CSS animations PAUSE while the panel document is
    // hidden, but this wall-clock timer keeps running (throttled, not paused) —
    // so closing and reopening the panel mid-strike would pull the epoch before
    // the digits finished. What the animations actually need is STRIKE_MS of
    // VISIBLE time: track every hidden stretch, and at each check recompute the
    // deadline as STRIKE_MS + hiddenTotal − elapsed. While hidden the check
    // parks rather than re-arms (the animations aren't moving, and a hidden
    // timer is throttled into churn); the visibility edge resumes it. The +100
    // slack errs the last re-arm late — the safe direction: a late clear keeps
    // the glow a beat longer, an early one yanks it mid-flicker.
    const start = performance.now();
    let hiddenTotal = 0;
    // `null` when visible — a clock value, so truthiness shouldn't be the test.
    let hiddenSince: number | null = document.hidden ? start : null;
    let parked = false;
    let timer = 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenSince = performance.now();
      } else {
        if (hiddenSince != null) {
          hiddenTotal += performance.now() - hiddenSince;
          hiddenSince = null;
        }
        if (parked) {
          parked = false;
          timer = window.setTimeout(check, 0);
        }
      }
    };
    const check = () => {
      timer = 0;
      // Charge the OPEN hidden stretch here, not only at the visibility edge:
      // the timer can fire mid-stretch (throttled, but it fires), and at that
      // moment hiddenTotal still reads 0 because no edge has happened — an
      // uncharged deadline would clear the strike while the animations sit
      // paused. This is the case "close the panel, come back later".
      if (hiddenSince != null) {
        hiddenTotal += performance.now() - hiddenSince;
        hiddenSince = document.hidden ? performance.now() : null;
      }
      if (document.hidden) {
        parked = true; // nothing is animating; the visibility edge resumes
        return;
      }
      const remaining = STRIKE_MS + hiddenTotal - (performance.now() - start);
      if (remaining > 0) {
        // +100 slack errs late — and under coarsened timer clocks the initial
        // timer can land a hair early, so the never-hidden path may take one
        // extra hop through here. Both in the safe direction.
        timer = window.setTimeout(check, remaining + 100);
        return;
      }
      document.removeEventListener("visibilitychange", onVisibility);
      setEpoch(0);
    };
    document.addEventListener("visibilitychange", onVisibility);
    timer = window.setTimeout(check, STRIKE_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearTimeout(timer);
    };
  }, [sats, unconfirmed, ready, arming]);
  return epoch;
}
