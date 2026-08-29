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

import { ANIMATIONS_KEY } from "@/lib/animations-pref";
import { COLLAPSE_THRESHOLD_PX } from "@/sidepanel/hero-collapse";

type Listener = (scrollY: number) => void;

const listeners = new Set<Listener>();
let lastScrollY = 0;
/** Cancels whichever scene ease is in flight. One slot, because the moon can
 *  only be going to one place at a time and whichever call arrives last wins. */
let cancelActiveEase: () => void = () => {};

const prefersReducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Settings → Animations, mirrored here.
 *
 * The switch promises to turn the app's decorative motion off, and until now it
 * did not reach the scene at all: someone who flipped it still got the full
 * starfield parallax and the moon travelling on every scroll. That is a promise
 * the switch was not keeping, and worse than the OS preference being ignored
 * would be, because it is an explicit action rather than an inference.
 *
 * Cached rather than read per call because this module is synchronous and the
 * preference lives in async storage. Optimistic `true` matches useAnimations, so
 * the scene behaves normally until storage says otherwise; the seed and the
 * subscription below correct it within a tick. Both are guarded so importing
 * this module outside an extension page (the node test environment) is safe.
 */
let animationsEnabled = true;

// Reached through globalThis rather than @/lib/ext on purpose: that module
// evaluates the `chrome` global at import time, and scene-scroll is imported by
// node-environment unit tests where it does not exist.
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

/**
 * Whether the scene may move at all.
 *
 * Either signal suppresses it: the OS preference, and the app's own switch.
 * Note this governs the DECORATIVE axes only — the starfield's parallax and the
 * water dim. The moon is layout, not decoration (parked it clears the sub-view
 * header), so parkSceneMoon still moves it either way, just without travel.
 */
const sceneMayMove = () => animationsEnabled && !prefersReducedMotion();

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
export const MOON_CLEARED_SCROLL_PX = MOON_DEAD_ZONE_PX + MOON_RANGE_PX;

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

/** The scene's three layers and who may write each.
 *
 *  `writeScene` moves all of them; `writeMoonOnly` and `writeStarfieldOnly`
 *  exist because two callers must move exactly one. Motion-off parks the moon
 *  without disturbing decoration, and the intro drives the sky while CSS
 *  keyframes own the moon and the water. Splitting them is what keeps those two
 *  cases from writing a variable that something else is already animating. */
function setSceneVar(name: "--moon-rise" | "--scene-recede", value: number): void {
  document.documentElement.style.setProperty(name, value.toFixed(4));
}

function writeScene(progress: number, scrollY: number): void {
  // Only the offset is retained. Nothing needs the progress back, because it is
  // derivable from the offset — see easeSceneTo. That it fell out unused when the
  // ease stopped lerping the two independently is the invariant proving itself.
  lastScrollY = scrollY;
  setSceneVar("--moon-rise", progress);
  setSceneVar("--scene-recede", progress);
  for (const l of listeners) l(scrollY);
}

/** Report scroll: `progress` (0 at rest → 1 once the moon has cleared, eased)
 *  drives the moon and the water dim; `scrollY` (px) drives the star parallax.
 *  Cancels any reset in flight — the user's scroll always wins. */
export function setSceneScroll(progress: number, scrollY: number): void {
  if (!sceneMayMove()) return;
  cancelActiveEase();
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
 * Eases ONE value, the scroll offset, and derives the moon from it with
 * moonRise. The scene's state is genuinely one-dimensional: every write the
 * scroll gesture makes satisfies `progress === moonRise(scrollY)`. Easing the two
 * independently against a shared factor breaks that invariant mid-flight — for
 * the first quarter of the transition the sky is still inside the dead zone
 * while the moon is already a quarter gone, then they cross and the sky runs
 * ahead — which is a smaller version of the defect this fix exists to remove.
 * Deriving instead of lerping makes every intermediate frame a state the gesture
 * could actually produce, and drops a parameter.
 *
 * Eases from wherever the scene actually is, so a user who had scrolled partway
 * before navigating does not get a jump.
 */
/**
 * Walk one value from `from` to `to` over `durationMs`, easing, and hand each
 * frame to `write`. Returns a cancel.
 *
 * The single easing primitive in this module. Every scene motion is this shape —
 * the lock/reset walk home, a sub-view park, the intro's descent — differing
 * only in distance, duration, and which layers the writer touches. They were
 * three near-identical rAF loops until they were not.
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

/** Walk the scene back to rest — moon at apogee, sky home, water lit — eased,
 *  because every other motion in this gesture is eased and a hard cut would snap
 *  the whole backdrop. Called when the wallet view goes away (lock): the scene
 *  stays on screen behind that, so the walk is visible by design. */
export function resetSceneScroll(): void {
  if (!sceneMayMove()) {
    // Cancel anyway. Only reachable if the preference is flipped mid-ease, and
    // the callers happen to cancel on every path that matters, but relying on
    // that is safety by call-site rather than by construction.
    cancelActiveEase();
    return;
  }
  easeSceneTo(0);
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
 * Shares the one ease slot with resetSceneScroll on purpose: leaving home fires both
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
 * With motion off — the OS preference or Settings → Animations — none of that
 * applies. Only the moon is written, and without travel, because it is the one
 * piece here that is layout rather than decoration: parked, it clears the
 * sub-view header. The sky and the water stay where that user always sees them.
 */
/** Move the moon and nothing else.
 *
 *  The path for a user who has motion off. The moon still has to clear the
 *  sub-view header, so it is written; the starfield offset and the water dim
 *  are decoration and are left exactly where that user always sees them.
 *  Deliberately does not touch `lastScrollY` or notify listeners, so the sky
 *  cannot be dragged along by a transition. */
function writeMoonOnly(progress: number): void {
  setSceneVar("--moon-rise", progress);
}

export function parkSceneMoon(parked: boolean): void {
  // MOON_CLEARED_SCROLL_PX is the LEAST offset that clears the moon, not the
  // only one. A user who scrolled the history well past it already has the moon
  // at 1, so easing the offset back down to 329 would hold the moon still and
  // sweep the sky hundreds of pixels — the exact mirror of the bug being fixed,
  // and worse than the snap it replaced. Clamping keeps the two agreeing: if the
  // moon has nowhere to go, neither do the stars.
  const scrollY = parked ? Math.max(lastScrollY, MOON_CLEARED_SCROLL_PX) : 0;
  if (!sceneMayMove()) {
    cancelActiveEase();
    // Moon only. Writing the whole scene here used to move the starfield and
    // dim the water on a transition for users whose sky never moves anywhere
    // else in the app, since setSceneScroll returns early for them — motion in
    // exactly the one place they had asked for none.
    writeMoonOnly(parked ? 1 : 0);
    return;
  }
  easeSceneTo(scrollY);
}

/** How long the intro's moon takes to come down. Mirrors the 5s on
 *  `apogee-moon-descend` in theme.css; the two are the same fact and there is no
 *  way to read one from the other, so a change to either wants a change to both. */
export const INTRO_MOON_MS = 5_000;

/** When the intro hands the UI back: the delay on `apogee-content-in` in
 *  theme.css, which is when the logo starts fading in. Same mirroring caveat as
 *  INTRO_MOON_MS — nothing can read the stylesheet, so the two move together. */
export const INTRO_CONTENT_IN_MS = 3_500;

/** How far ahead of the logo the intro's first meteor is spawned.
 *
 *  A meteor lives well under a second, so this puts one mid-flight as the logo
 *  begins to arrive rather than landing on top of it. Left to itself the first
 *  spawn is random in a 2.5-5s window, which straddles the logo: sometimes a
 *  meteor greeted it, sometimes one crossed it, most often nothing happened. */
export const INTRO_METEOR_LEAD_MS = 600;

/** Notify the starfield WITHOUT touching the moon or the water.
 *
 *  The intro drives those two itself, in CSS: `apogee-moon-descend` owns the
 *  moon's transform, and `.apogee-intro-dim` owns the water through its own
 *  keyframes. Writing `--moon-rise` or `--scene-recede` here would fight both —
 *  and the second collision is the nastier one, because `.apogee-scroll-dim` is
 *  a separate element that would light up alongside the intro's own band, which
 *  its comment in theme.css explicitly relies on never happening. */
function writeStarfieldOnly(scrollY: number): void {
  lastScrollY = scrollY;
  for (const l of listeners) l(scrollY);
}

/**
 * Carry the starfield through the intro's moon descent.
 *
 * Everywhere else in the panel the moon and the sky travel together: scrolling
 * the history parallaxes both, and so does entering a sub-view. The intro was
 * the exception, because its moon is a CSS keyframe and the starfield only ever
 * moved when JS told it to — so the moon fell through a sky that was nailed in
 * place.
 *
 * Reuses the same ease as the scroll driver rather than reimplementing the
 * intro's `cubic-bezier(0.2, 0.6, 0.3, 1)` in JS. That is not an approximation
 * introduced here: `moonRise` already describes its cubic as "standing in for
 * the intro's cubic-bezier", so the two curves were already treated as the same
 * shape, and matching that keeps one easing in the module instead of two.
 *
 * Deliberately not gated on `sceneMayMove()`. App owns the intro's motion
 * decision and never reaches "play" with reduced motion or animations off;
 * checking again here would only add a way for a racing preference read to kill
 * a cinematic that had already been allowed to start.
 *
 * Returns a cancel function.
 */
export function driveIntroStarfield(intro: "hold" | "play" | false): () => void {
  if (intro === "hold") {
    // Parked, matching the moon the hold class pins above the panel, so the
    // hold and the first frame of the descent agree and nothing snaps.
    writeStarfieldOnly(MOON_CLEARED_SCROLL_PX);
    return () => {};
  }
  if (intro === false) {
    // Covers the capped hold: the panel gives up on the cinematic and shows the
    // wallet, and the sky must not stay parked from a descent that never ran.
    writeStarfieldOnly(0);
    return () => {};
  }
  // Parked, ALWAYS — not `lastScrollY`. The moon's keyframe declares an absolute
  // `from: translate(-50%, var(--moon-park))`, so it starts at the top whatever
  // the scene was doing a frame earlier, and the sky has to agree. Reading the
  // live value instead made the replay button a no-op: replay() goes
  // false -> one frame -> "play" without passing through "hold", so `from` was
  // the 0 the `false` branch had just written, and the sweep ran 0 to 0.
  return easeScene(MOON_CLEARED_SCROLL_PX, 0, INTRO_MOON_MS, writeStarfieldOnly);
}

export function subscribeScene(listener: Listener): () => void {
  listeners.add(listener);
  listener(lastScrollY);
  return () => {
    listeners.delete(listener);
  };
}
