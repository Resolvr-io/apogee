// Shared scroll signal driving the celestial backdrop. The wallet's scroll
// container reports here; the moon reads --moon-rise, the water and horizon glow
// read --scene-recede, and the starfield subscribes for its parallax redraw.
//
// prefers-reduced-motion is checked per call, not cached, so flipping it
// mid-session doesn't leave half the scene still scrubbing.

import { ANIMATIONS_KEY } from "@/lib/animations-pref";
import { COLLAPSE_THRESHOLD_PX } from "@/sidepanel/hero-collapse";

type Listener = (scrollY: number) => void;

const listeners = new Set<Listener>();
// Two slots, because the intro moves the sky while CSS keyframes own the moon
// and the water — motion with no scroll position behind it. Sharing one let that
// parked value leak into easeSceneTo's start point, lighting .apogee-scroll-dim
// over the intro's own band.
let lastScrollY = 0; // where the scroll driver has the scene
let lastStarfieldY = 0; // what the starfield was last told
/** Cancels whichever scene ease is in flight. One slot: the moon can only be
 *  going to one place at a time, so the last call wins. */
let cancelActiveEase: () => void = () => {};

const prefersReducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Settings → Animations, mirrored here.
 *
 * Cached rather than read per call because this module is synchronous and the
 * preference lives in async storage. Optimistic `true` matches useAnimations; the
 * seed and subscription below correct it within a tick. Both are guarded so
 * importing this module outside an extension page (node tests) is safe.
 */
let animationsEnabled = true;

// Reached through globalThis rather than @/lib/ext, which evaluates the `chrome`
// global at import time and so breaks the node-environment unit tests.
const extensionStorage = (
  globalThis as {
    chrome?: {
      storage?: {
        local?: { get(key: string): Promise<Record<string, unknown>> };
        onChanged?: {
          addListener(
            listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void,
          ): void;
        };
      };
    };
  }
).chrome?.storage;

if (extensionStorage?.local) {
  void extensionStorage.local
    .get(ANIMATIONS_KEY)
    .then((stored) => {
      if (ANIMATIONS_KEY in stored) animationsEnabled = Boolean(stored[ANIMATIONS_KEY]);
    })
    .catch(() => {
      /* the optimistic default stands */
    });
  extensionStorage.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !(ANIMATIONS_KEY in changes)) return;
    animationsEnabled = Boolean(changes[ANIMATIONS_KEY]?.newValue ?? true);
  });
}

/** Whether the scene may move: the OS preference, or the app's own switch.
 *
 *  Governs the DECORATIVE axes only. The moon is layout — parked, it clears the
 *  sub-view header — so parkSceneMoon still moves it either way, just without
 *  travel. */
const sceneMayMove = () => animationsEnabled && !prefersReducedMotion();

/** How far the list scrolls before the moon moves: the hero collapse's
 *  engagement point, imported rather than re-derived because this number and
 *  that one are the same fact. */
const MOON_DEAD_ZONE_PX = COLLAPSE_THRESHOLD_PX;

/** Travel over which the moon clears the panel, counted from the dead zone. */
const MOON_RANGE_PX = 240;

/** How long a scene transition (reset, park) takes to reach its target. */
const RESET_MS = 260;

/** The scroll offset at which the moon has fully cleared the panel. */
export const MOON_CLEARED_SCROLL_PX = MOON_DEAD_ZONE_PX + MOON_RANGE_PX;

/**
 * The moon's exit progress for a scroll offset: 0 inside the dead zone, 1 once
 * it has cleared. Eased with the intro descend's character — fast away, long
 * settle — so the exit reads as the cinematic in reverse rather than a scrub.
 */
export function moonRise(scrollTop: number): number {
  const t = Math.min(1, Math.max(0, (scrollTop - MOON_DEAD_ZONE_PX) / MOON_RANGE_PX));
  return 1 - (1 - t) ** 3; // stands in for the intro's cubic-bezier(0.2, 0.6, 0.3, 1)
}

/** The scene's three layers and who may write each.
 *
 *  `writeScene` moves all of them; `writeMoonOnly` and `writeStarfieldOnly` exist
 *  because two callers must move exactly one — motion-off parks the moon without
 *  disturbing decoration, and the intro drives the sky while CSS owns the moon
 *  and the water. Splitting them keeps those cases off a variable something else
 *  is already animating. */
function setSceneVar(name: "--moon-rise" | "--scene-recede", value: number): void {
  document.documentElement.style.setProperty(name, value.toFixed(4));
}

function writeScene(progress: number, scrollY: number): void {
  // Only the offset is retained; the progress is derivable from it (see
  // easeSceneTo), so nothing needs it back.
  lastScrollY = scrollY;
  lastStarfieldY = scrollY;
  setSceneVar("--moon-rise", progress);
  setSceneVar("--scene-recede", progress);
  for (const l of listeners) l(scrollY);
}

/** Report scroll: `progress` drives the moon and the water dim, `scrollY` the
 *  star parallax. Cancels any reset in flight — the user's scroll always wins. */
export function setSceneScroll(progress: number, scrollY: number): void {
  if (!sceneMayMove()) return;
  cancelActiveEase();
  writeScene(progress, scrollY);
}

/**
 * Walk one value from `from` to `to` over `durationMs`, easing, handing each
 * frame to `write`. Returns a cancel.
 *
 * The module's single easing primitive: the lock/reset walk home, a sub-view
 * park, and the intro's descent are all this shape, differing only in distance,
 * duration, and which layers the writer touches.
 */
function easeScene(
  from: number,
  to: number,
  durationMs: number,
  write: (scrollY: number) => void,
): () => void {
  const start = performance.now();
  let raf = requestAnimationFrame(function step(now: number) {
    const k = Math.min(1, (now - start) / durationMs);
    const eased = 1 - (1 - k) ** 3;
    write(from + (to - from) * eased);
    raf = k < 1 ? requestAnimationFrame(step) : 0;
  });
  return () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
}

/**
 * Ease the whole scene to a target, moon and starfield together. Writing one and
 * pinning the other is what made the moon slide out of a motionless sky when
 * entering a sub-view.
 *
 * Eases ONE value — the scroll offset — and derives the moon from it. The scene's
 * state is one-dimensional: every write the scroll gesture makes satisfies
 * `progress === moonRise(scrollY)`. Easing the two independently against a shared
 * factor breaks that mid-flight, so every intermediate frame here is a state the
 * gesture could actually produce.
 *
 * Eases from wherever the scene is, so scrolling partway before navigating does
 * not produce a jump.
 */
function easeSceneTo(toScrollY: number): void {
  cancelActiveEase();
  const fromScrollY = lastScrollY;
  if (fromScrollY === toScrollY) {
    writeScene(moonRise(toScrollY), toScrollY);
    return;
  }
  cancelActiveEase = easeScene(fromScrollY, toScrollY, RESET_MS, (scrollY) =>
    writeScene(moonRise(scrollY), scrollY),
  );
}

/** Walk the scene back to rest — moon at apogee, sky home, water lit. Called
 *  when the wallet view goes away (lock); the scene stays on screen behind that,
 *  so the walk is visible by design. */
export function resetSceneScroll(): void {
  if (!sceneMayMove()) {
    // Cancel anyway. Only reachable if the preference flips mid-ease, and the
    // callers happen to cancel on every path that matters — but that is safety
    // by call-site rather than by construction.
    cancelActiveEase();
    return;
  }
  easeSceneTo(0);
}

/** Move the moon and nothing else: the path for a user with motion off. The moon
 *  still has to clear the sub-view header, so it is written; the starfield offset
 *  and water dim are decoration and stay where that user always sees them.
 *  Touches neither retained offset, so the sky can't be dragged along. */
function writeMoonOnly(progress: number): void {
  setSceneVar("--moon-rise", progress);
}

/**
 * Park the moon above the panel, or release it, easing either way.
 *
 * Every view but home stacks a second header under the app header, and the
 * moon's resting position sits behind exactly that band. Leaving home used to
 * call resetSceneScroll, which walks the moon back DOWN into it — right for the
 * lock screen, wrong for a sub-view.
 *
 * Wider than the name suggests: writeScene couples --moon-rise with
 * --scene-recede, so the water dims and the glow dies, and the starfield eases
 * along so the moon doesn't slide out over a frozen sky.
 *
 * NOT gated on reduced motion the way setSceneScroll and resetSceneScroll are.
 * Those are pure decoration; this is layout, and skipping it would leave the moon
 * on top of the back button for exactly the users who asked for less motion. The
 * preference is honored by cutting the animation, not the move.
 */
export function parkSceneMoon(parked: boolean): void {
  // MOON_CLEARED_SCROLL_PX is the LEAST offset that clears the moon, not the only
  // one. Someone scrolled well past it already has the moon at 1, so easing back
  // down to it would hold the moon still and sweep the sky hundreds of pixels.
  const scrollY = parked ? Math.max(lastScrollY, MOON_CLEARED_SCROLL_PX) : 0;
  if (!sceneMayMove()) {
    cancelActiveEase();
    writeMoonOnly(parked ? 1 : 0);
    return;
  }
  easeSceneTo(scrollY);
}

/** How long the intro's moon takes to come down. Mirrors `apogee-moon-descend`
 *  in theme.css — nothing can read a stylesheet, so the two move together. */
export const INTRO_MOON_MS = 5_000;

/** When the logo starts fading in: the delay on `apogee-content-in` in theme.css.
 *  Same mirroring caveat as INTRO_MOON_MS. */
export const INTRO_CONTENT_IN_MS = 3_500;

/** How far ahead of the logo the intro's first meteor spawns. A meteor lives
 *  well under a second, so this puts one mid-flight as the logo arrives rather
 *  than landing on top of it. */
export const INTRO_METEOR_LEAD_MS = 600;

/** Notify the starfield WITHOUT touching the moon or the water.
 *
 *  The intro drives those in CSS: `apogee-moon-descend` owns the moon's
 *  transform and `.apogee-intro-dim` owns the water. Writing --moon-rise or
 *  --scene-recede here would fight both, and the second collision is the nastier
 *  one — `.apogee-scroll-dim` is a separate element that would light up beside
 *  the intro's own band. */
function writeStarfieldOnly(scrollY: number): void {
  lastStarfieldY = scrollY;
  for (const l of listeners) l(scrollY);
}

/**
 * Carry the starfield through the intro's moon descent.
 *
 * Everywhere else the moon and sky travel together; the intro was the exception,
 * because its moon is a CSS keyframe and the starfield only moves when JS says
 * so, so the moon fell through a sky nailed in place.
 *
 * Reuses the scroll driver's ease rather than reimplementing the intro's
 * cubic-bezier: moonRise already stands in for that curve, so the two were
 * already treated as the same shape.
 *
 * Not gated on sceneMayMove(). App owns the intro's motion decision and never
 * reaches "play" with motion off; re-checking here would only add a way for a
 * racing preference read to kill a cinematic already allowed to start.
 *
 * Returns a cancel function.
 */
export function driveIntroStarfield(intro: "hold" | "play" | false): () => void {
  if (intro === "hold") {
    // Matches the moon the hold class pins above the panel, so the hold and the
    // first frame of the descent agree and nothing snaps.
    writeStarfieldOnly(MOON_CLEARED_SCROLL_PX);
    return () => {};
  }
  if (intro === false) {
    // Covers the capped hold: the sky must not stay parked from a descent that
    // never ran.
    writeStarfieldOnly(0);
    return () => {};
  }
  // Parked ALWAYS, not lastScrollY. The moon's keyframe declares an absolute
  // `from`, so it starts at the top whatever the scene was doing a frame earlier.
  // Reading the live value made the replay button a no-op: replay() goes
  // false -> one frame -> "play" without passing through "hold", so the sweep ran
  // 0 to 0.
  //
  // Into the shared cancel slot so the one-slot rule above stays true. Nothing
  // reaches this concurrently today, but two loops writing the same listeners
  // with neither able to stop the other is not a state to leave open.
  cancelActiveEase();
  cancelActiveEase = easeScene(MOON_CLEARED_SCROLL_PX, 0, INTRO_MOON_MS, writeStarfieldOnly);
  return cancelActiveEase;
}

export function subscribeScene(listener: Listener): () => void {
  listeners.add(listener);
  listener(lastStarfieldY);
  return () => {
    listeners.delete(listener);
  };
}
