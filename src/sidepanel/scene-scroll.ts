// Shared scroll signal that drives the celestial backdrop's parallax. The
// wallet's scroll container reports progress here; the moon reads the
// --moon-rise CSS variable (so it rises off the top of the panel — the intro's
// descend, reversed), the water and the horizon glow read --scene-recede (the
// sea dims deeper than its pre-arrival level and the moonlit dome dies with
// it), and the starfield subscribes for its depth-parallax redraw.
//
// Respects prefers-reduced-motion, checked per call rather than cached: the
// fold's reduced-motion handling is a live CSS media query, and a user who
// flips the preference mid-session shouldn't have one half of the scene still
// scrubbing.

import { COLLAPSE_THRESHOLD_PX } from "@/sidepanel/hero-collapse";

type Listener = (scrollY: number) => void;

const listeners = new Set<Listener>();
let lastScrollY = 0;
let lastProgress = 0;
let resetRaf = 0;

const prefersReducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How far the list must scroll before the moon starts to move: exactly the
 *  hero collapse's engagement point (see hero-collapse.ts), so the moon and
 *  the compacting frame set off as one gesture. Imported, not re-derived —
 *  this number and that one are the same fact. */
const MOON_DEAD_ZONE_PX = COLLAPSE_THRESHOLD_PX;

/** Travel over which the moon clears the panel, counted from the dead zone.
 *  Roughly the hero's own collapse distance: the moon is gone by the time the
 *  list has fully taken the frame's space. */
const MOON_RANGE_PX = 240;

/** How long the reset (see resetSceneScroll) takes to walk the scene home. */
const RESET_MS = 260;

/**
 * The moon's exit progress for a list scroll offset: 0 while the scroll is
 * inside the dead zone (the moon holds its apogee), 1 once it has cleared.
 * Eased with the intro descend's character — fast away, long settle — so the
 * exit feels like the cinematic in reverse rather than a linear scrub.
 */
export function moonRise(scrollTop: number): number {
  const t = Math.min(1, Math.max(0, (scrollTop - MOON_DEAD_ZONE_PX) / MOON_RANGE_PX));
  return 1 - (1 - t) ** 3; // ease-out, standing in for the intro's cubic-bezier(0.2, 0.6, 0.3, 1)
}

function writeScene(progress: number, scrollY: number): void {
  lastScrollY = scrollY;
  lastProgress = progress;
  document.documentElement.style.setProperty("--moon-rise", progress.toFixed(4));
  document.documentElement.style.setProperty("--scene-recede", progress.toFixed(4));
  for (const l of listeners) l(scrollY);
}

/** Report scroll: `progress` (0 at rest → 1 once the moon has cleared, eased)
 *  drives the moon and the water dim; `scrollY` (px) drives the star parallax.
 *  Cancels any reset in flight — the user's scroll always wins. */
export function setSceneScroll(progress: number, scrollY: number): void {
  if (prefersReducedMotion()) return;
  if (resetRaf) {
    cancelAnimationFrame(resetRaf);
    resetRaf = 0;
  }
  writeScene(progress, scrollY);
}

/** Walk the scene back to rest — moon at apogee, water lit — eased, because
 *  every other motion in this gesture is eased and a hard cut would snap the
 *  whole backdrop. Called when the wallet view goes away (sub-view, lock): the
 *  scene stays on screen behind those, so the walk is visible by design. */
export function resetSceneScroll(): void {
  if (prefersReducedMotion()) return;
  if (resetRaf) cancelAnimationFrame(resetRaf);
  const from = lastProgress;
  if (from <= 0) {
    resetRaf = 0;
    writeScene(0, 0);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / RESET_MS);
    const eased = 1 - (1 - k) ** 3;
    writeScene(from * (1 - eased), 0);
    resetRaf = k < 1 ? requestAnimationFrame(step) : 0;
  };
  resetRaf = requestAnimationFrame(step);
}

export function subscribeScene(listener: Listener): () => void {
  listeners.add(listener);
  listener(lastScrollY);
  return () => {
    listeners.delete(listener);
  };
}
