// The Settings → Animations storage key, alone in a zero-dependency module.
//
// Two modules need it: use-animations.ts (the hook behind the switch) and
// scene-scroll.ts (which mirrors the preference to decide whether the backdrop
// may move). scene-scroll is imported by node-environment unit tests, so it must
// not reach anything that touches the `chrome` global at import time — which is
// what @/lib/ext does, and why the key cannot simply live beside the hook.
export const ANIMATIONS_KEY = "apogee:animations";
