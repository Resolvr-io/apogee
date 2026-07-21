// Preference for the animated ocean backdrop. Animated by default; persisted in
// browser.storage.local so the Settings toggle and the Scene stay in sync across
// the panel (both subscribe to browser.storage.onChanged). Mirrors useHideBalance.

import { useCallback, useEffect, useState } from "react";
import { browser } from "@/lib/ext";

const ANIM_KEY = "apogee:animations";

/** `[animated, setAnimated]` — `true` (animated) until storage says otherwise. */
export function useAnimations(): [boolean, (value: boolean) => void] {
  const [animated, setAnimated] = useState(true);
  useEffect(() => {
    void browser.storage.local.get(ANIM_KEY).then((o) => {
      if (ANIM_KEY in o) setAnimated(Boolean(o[ANIM_KEY]));
    });
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
  return [animated, set];
}
