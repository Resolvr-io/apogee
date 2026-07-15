// Shared scroll signal that drives the celestial backdrop's parallax. The
// wallet's scroll container reports progress here; the moon reads the
// --moon-descent CSS variable (so it descends from its apogee toward the
// horizon) and the starfield subscribes for its depth-parallax redraw.
//
// Respects prefers-reduced-motion: when set, the scene stays put (moon at its
// apogee, stars static).

type Listener = (scrollY: number) => void;

const listeners = new Set<Listener>();
let lastScrollY = 0;

const reduceMotion =
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Report scroll: `progress` (0 at top → 1 at bottom, pre-eased) drives the
 *  moon's descent; `scrollY` (px) drives the star parallax. */
export function setSceneScroll(progress: number, scrollY: number): void {
  if (reduceMotion) return;
  lastScrollY = scrollY;
  document.documentElement.style.setProperty("--moon-descent", progress.toFixed(4));
  for (const l of listeners) l(scrollY);
}

/** Return the scene to the top (moon at apogee) — e.g. on lock or view change. */
export function resetSceneScroll(): void {
  if (reduceMotion) return;
  setSceneScroll(0, 0);
}

export function subscribeScene(listener: Listener): () => void {
  listeners.add(listener);
  listener(lastScrollY);
  return () => {
    listeners.delete(listener);
  };
}
