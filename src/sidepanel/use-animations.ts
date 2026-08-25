// Preference for the app's decorative motion — the animated ocean backdrop and
// the balance's neon strike. Animated by default; persisted in
// browser.storage.local so the Settings toggle, the Scene, and the strike stay
// in sync across the panel (all subscribe to browser.storage.onChanged).
// Mirrors useHideBalance.

import { useCallback, useEffect, useState } from "react";
import { browser } from "@/lib/ext";

const ANIM_KEY = "apogee:animations";

/**
 * `[animated, setAnimated, loaded]` — `true` (animated) until storage says
 * otherwise. `loaded` reports whether the stored preference has actually been
 * read yet; before then `animated` is only the optimistic default. Callers that
 * merely render can ignore it, but anything making a ONE-SHOT decision off the
 * preference has to wait for it, or it races the read and can act on the
 * default (see useMoonIntro in App.tsx).
 */
export function useAnimations(): [boolean, (value: boolean) => void, boolean] {
  const [animated, setAnimated] = useState(true);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void browser.storage.local.get(ANIM_KEY).then(
      (o) => {
        if (ANIM_KEY in o) setAnimated(Boolean(o[ANIM_KEY]));
        setLoaded(true);
      },
      // A failed read leaves the default in place; still "loaded", so a waiting
      // caller proceeds rather than hanging on storage that will never answer.
      () => setLoaded(true),
    );
    const onChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === "local" && ANIM_KEY in changes) {
        setAnimated(Boolean(changes[ANIM_KEY].newValue));
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);
  const set = useCallback((value: boolean) => {
    setAnimated(value);
    void browser.storage.local.set({ [ANIM_KEY]: value });
  }, []);
  return [animated, set, loaded];
}
