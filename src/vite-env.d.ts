/// <reference types="vite/client" />
/// <reference types="chrome" />

// Injected by vite.config.ts (define) — see src/version.ts.
declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;
// Build-time target flag: true in the Firefox build (scripts/build-firefox.ts),
// false in the Chrome/crxjs build (vite.config.ts). Lets each build tree-shake
// the other target's code paths.
declare const __FIREFOX__: boolean;
