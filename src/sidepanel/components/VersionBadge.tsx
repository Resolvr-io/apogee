// Transient version readout pinned to the bottom of the panel. Confirms which
// build is running — handy in development, and lets a user check they're on the
// latest release — then fades out so it never becomes furniture. It stacks
// below the connection bar and the main content, so an active bar simply
// covers it and it can't obscure anything interactive.

import { useEffect, useState } from "react";
import { APP_VERSION_DISPLAY } from "@/version";

const VISIBLE_MS = 15_000;
const FADE_MS = 1_000; // matches duration-1000 below

export function VersionBadge() {
  const [fading, setFading] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const fade = window.setTimeout(() => setFading(true), VISIBLE_MS);
    const remove = window.setTimeout(() => setGone(true), VISIBLE_MS + FADE_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(remove);
    };
  }, []);

  if (gone) return null;
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-x-0 bottom-2 z-[5] text-center transition-opacity duration-1000 ${
        fading ? "opacity-0" : "opacity-100"
      }`}
    >
      <span className="console-value text-[10px] text-[color:var(--text-subtle)]">
        v{APP_VERSION_DISPLAY}
      </span>
    </div>
  );
}
