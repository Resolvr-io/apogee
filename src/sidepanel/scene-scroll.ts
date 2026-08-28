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

/** How long a scene transition (reset, park) takes to walk to its target. */
const RESET_MS = 260;

/** The list scroll offset at which the moon has fully cleared the panel.
 *
 *  Parking eases the starfield TO this value rather than leaving it where it
 *  was, because the starfield's parallax is driven by the scroll offset and the
 *  moon by the progress. Move one without the other and the moon slides away
 *  over a frozen sky, which reads as broken next to the scroll gesture where
 *  they travel together. */
const MOON_CLEARED_SCROLL_PX = MOON_DEAD_ZONE_PX + MOON_RANGE_PX;

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

/**
 * Ease the whole scene to a target, moon and starfield together.
 *
 * Both values have to travel or the scene comes apart: `--moon-rise` moves the
 * moon, while the starfield subscribes to the scroll offset for its depth
 * parallax. Writing one and pinning the other at 0 is what made the moon slide
 * out of a motionless sky on entering a sub-view, when the same moon travelling
 * under a scroll gesture carries the stars with it.
 *
 * Eases from wherever the scene actually is, so a user who had scrolled partway
 * before navigating does not get a jump.
 */
function easeSceneTo(toProgress: number, toScrollY: number): void {
  if (resetRaf) cancelAnimationFrame(resetRaf);
  const fromProgress = lastProgress;
  const fromScrollY = lastScrollY;
  if (fromProgress === toProgress && fromScrollY === toScrollY) {
    resetRaf = 0;
    writeScene(toProgress, toScrollY);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / RESET_MS);
    const eased = 1 - (1 - k) ** 3;
    writeScene(
      fromProgress + (toProgress - fromProgress) * eased,
      fromScrollY + (toScrollY - fromScrollY) * eased,
    );
    resetRaf = k < 1 ? requestAnimationFrame(step) : 0;
  };
  resetRaf = requestAnimationFrame(step);
}

/** Walk the scene back to rest — moon at apogee, sky home, water lit — eased,
 *  because every other motion in this gesture is eased and a hard cut would snap
 *  the whole backdrop. Called when the wallet view goes away (lock): the scene
 *  stays on screen behind that, so the walk is visible by design. */
export function resetSceneScroll(): void {
  if (prefersReducedMotion()) return;
  easeSceneTo(0, 0);
}

/**
 * Park the moon above the panel, or release it, easing either way.
 *
 * Why this exists: every view but home stacks a second header (back button +
 * title) under the app header, and the moon's resting position sits behind
 * exactly that band — the app header is 56px tall, the sub-view header is
 * another 56, and the moon spans roughly 40 to 96. Leaving home used to call
 * resetSceneScroll(), which walks the moon back DOWN into that band; correct
 * for the lock screen, which has no second header, and wrong for a sub-view.
 *
 * Deliberately NOT gated on prefers-reduced-motion the way setSceneScroll and
 * resetSceneScroll are. Those two are pure decoration, so declining to run them
 * costs nothing. This one is load-bearing layout: skipping it would leave the
 * moon sitting on top of the back button for exactly the users who asked for
 * less motion. The preference is honored by cutting the ANIMATION, not the
 * move — reduced motion jumps straight to the parked position.
 *
 * Shares `resetRaf` with resetSceneScroll on purpose: leaving home fires both
 * (that function's cleanup, then this), and whichever runs last must win rather
 * than the two easing against each other.
 *
 * Note the blast radius, because it is wider than the name suggests. Parking
 * moves the whole scene, not just the moon: writeScene couples `--moon-rise`
 * with `--scene-recede`, so the water dims and the horizon glow dies, and the
 * starfield is eased to the scroll offset at which the moon has cleared so the
 * sky travels with it. That last part is not decoration — the moon sliding out
 * over a frozen starfield is visibly wrong beside the scroll gesture, where the
 * two move together.
 *
 * The consequence for reduced motion: those users, for whom setSceneScroll
 * returns early and who therefore never saw any of this move, now get the
 * parked scene on every sub-view. Applied as a jump rather than an animation,
 * which is the preference honored correctly, but it is a change for them.
 */
export function parkSceneMoon(parked: boolean): void {
  const progress = parked ? 1 : 0;
  const scrollY = parked ? MOON_CLEARED_SCROLL_PX : 0;
  if (prefersReducedMotion()) {
    if (resetRaf) {
      cancelAnimationFrame(resetRaf);
      resetRaf = 0;
    }
    writeScene(progress, scrollY);
    return;
  }
  easeSceneTo(progress, scrollY);
}

export function subscribeScene(listener: Listener): () => void {
  listeners.add(listener);
  listener(lastScrollY);
  return () => {
    listeners.delete(listener);
  };
}
