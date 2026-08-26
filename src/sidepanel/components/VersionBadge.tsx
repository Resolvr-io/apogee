// Transient version readout pinned to the bottom of the panel. Confirms which
// build is running — handy in development, and lets a user check they're on the
// latest release — then fades out so it never becomes furniture. It stacks
// below the connection bar and the main content, so an active bar simply
// covers it and it can't obscure anything interactive.
//
// Clicking copies the version string verbatim (bug-report aid); the only
// acknowledgment is a brief shift to the primary ink — no label, this stays furniture. Only
// the text itself takes clicks; the strip stays pass-through.
//
// It fades in as well as out. App mounts it only once the first-run intro has
// finished, so without an entrance it would pop into a scene that had just
// spent five seconds easing everything else in.

import { useEffect, useRef, useState } from "react";
import { APP_VERSION_DISPLAY } from "@/version";

const VISIBLE_MS = 15_000; // from mount to the start of the fade-out
const FADE_MS = 1_000; // matches duration-1000 below

export function VersionBadge() {
  const [shown, setShown] = useState(false);
  const [gone, setGone] = useState(false);
  // Copy feedback is color alone — text stays put. Reverts after a beat.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

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
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    };
  }, []);

  async function copyVersion() {
    try {
      await navigator.clipboard.writeText(APP_VERSION_DISPLAY);
    } catch {
      return; // clipboard blocked/failed — no shift for a copy that didn't happen
    }
    setCopied(true);
    if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
  }

  if (gone) return null;
  // z-20 clears the two positioned layers sharing this strip — main's scroll
  // column and ConnectionBar are both z-10, which otherwise win hit-testing
  // and the copy click never reaches the text (they're transparent here, so
  // only clicks reveal the stacking). Toasts sit above at z-30 and take no
  // pointer events.
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-2 z-20 text-center transition-opacity duration-1000 motion-reduce:transition-none ${
        shown ? "opacity-100" : "opacity-0"
      }`}
    >
      <button
        type="button"
        title="Click to copy version"
        onClick={() => void copyVersion()}
        className={`pointer-events-auto cursor-pointer console-value text-[10px] transition-colors ${
          copied ? "text-[color:var(--text-primary)]" : "text-[color:var(--text-subtle)]"
        }`}
      >
        v{APP_VERSION_DISPLAY}
      </button>
    </div>
  );
}
