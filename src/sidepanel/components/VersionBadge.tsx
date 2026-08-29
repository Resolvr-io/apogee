// Transient version readout pinned to the bottom of the panel. Confirms which
// build is running — handy in development, and lets a user check they're on the
// latest release — then fades out so it never becomes furniture. It stacks
// below the connection bar and the main content, so an active bar simply
// covers it and it can't obscure anything interactive.
//
// It fades in as well as out. App mounts it only once the first-run intro has
// finished, so without an entrance it would pop into a scene that had just
// spent five seconds easing everything else in.

import { useEffect, useState } from "react";
import { APP_VERSION_DISPLAY } from "@/version";

const VISIBLE_MS = 15_000; // from mount to the start of the fade-out
const FADE_MS = 1_000; // matches duration-1000 below

/**
 * The panel's transient bottom chrome: visible on arrival, then faded out so it
 * never becomes furniture.
 *
 * Exported because the debug Replay-intro button shares the timing. Two
 * separate timers would drift, and worse, they would drift *visibly* — the two
 * sit at the bottom of the same screen, so one lingering after the other reads
 * as a bug rather than a coincidence. `gone` is only for the badge: the button
 * must stay mounted after it fades, or it could not be hovered back.
 */
export function useTransientChrome(): { shown: boolean; gone: boolean } {
  const [shown, setShown] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    // Two frames, not one: the opacity-0 state has to be painted before the
    // change to opacity-100, or the browser coalesces both into the first paint
    // and the transition never runs (the pop this exists to avoid).
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setShown(true));
    });
    const fade = window.setTimeout(() => setShown(false), VISIBLE_MS);
    const remove = window.setTimeout(() => setGone(true), VISIBLE_MS + FADE_MS);
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      window.clearTimeout(fade);
      window.clearTimeout(remove);
    };
  }, []);

  return { shown, gone };
}

export function VersionBadge() {
  const { shown, gone } = useTransientChrome();

  if (gone) return null;
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-x-0 bottom-2 z-[5] text-center transition-opacity duration-1000 motion-reduce:transition-none ${
        shown ? "opacity-100" : "opacity-0"
      }`}
    >
      <span className="console-value text-[10px] text-[color:var(--text-subtle)]">
        v{APP_VERSION_DISPLAY}
      </span>
    </div>
  );
}
