// Transient version readout pinned to the bottom of the panel. Confirms which
// build is running — handy in development, and lets a user check they're on the
// latest release — then fades out so it never becomes furniture. It stacks
// below the connection bar and the main content, so an active bar simply
// covers it and it can't obscure anything interactive.
//
// Clicking copies the version string verbatim — a bug-report aid. The only
// acknowledgment is a brief shift to the primary ink: no label, no layout
// change, because this stays furniture. Only the text takes clicks; the strip
// around it stays pass-through.
//
// It fades in as well as out. App mounts it only once the first-run intro has
// finished, so without an entrance it would pop into a scene that had just
// spent five seconds easing everything else in.

import { useEffect, useRef, useState } from "react";
import { APP_VERSION_DISPLAY } from "@/version";

const VISIBLE_MS = 15_000; // from mount to the start of the fade-out
const FADE_MS = 1_000; // matches duration-1000 below

/**
 * The panel's transient bottom chrome: visible on arrival, then faded out so it
 * never becomes furniture.
 *
 * Exported because the debug Replay-intro button gets the same treatment. It
 * shares the POLICY, not a clock — each caller gets its own instance and its own
 * pair of timers, so the two coincide only when they mounted together. On first
 * run they don't: App gates the badge on the intro having finished, while the
 * button's instance starts with the panel, so the badge outlasts it by roughly
 * the length of the intro. Nor can they be made to share one, because the badge
 * re-arms after a replay by design and the button deliberately does not. What
 * the sharing buys is one definition of the durations rather than two.
 *
 * `gone` is only for the badge: the button must stay mounted after it fades, or
 * it could not be hovered back.
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
  // Copy feedback is color alone, so the readout never changes width and the
  // strip cannot reflow under it. Local to this component rather than part of
  // useTransientChrome: the replay button shares that hook and has nothing to
  // copy.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  async function copyVersion() {
    try {
      await navigator.clipboard.writeText(APP_VERSION_DISPLAY);
    } catch {
      return; // blocked or failed — no shift for a copy that didn't happen
    }
    setCopied(true);
    if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
  }

  if (gone) return null;
  // z-20, not z-[5]: main's scroll column and ConnectionBar both sit at z-10 and
  // would win hit-testing over this strip, so the click never reached the text.
  // They are transparent here, which is why only a click revealed the stacking.
  // Toasts stay above at z-30 and take no pointer events.
  //
  // No aria-hidden any more either — it held a span before, and hiding a real
  // button from the accessibility tree would make the copy unreachable by
  // keyboard while leaving it focusable.
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-2 z-20 text-center transition-opacity duration-1000 motion-reduce:transition-none ${
        shown ? "opacity-100" : "opacity-0"
      }`}
    >
      <button
        type="button"
        title={copied ? "Copied" : "Click to copy version"}
        onClick={() => void copyVersion()}
        className={`console-value pointer-events-auto cursor-pointer text-[10px] transition-colors ${
          copied ? "text-[color:var(--text-primary)]" : "text-[color:var(--text-subtle)]"
        }`}
      >
        v{APP_VERSION_DISPLAY}
      </button>
    </div>
  );
}
