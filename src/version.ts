// Single source of truth: apps/apogee/package.json, injected at build time by
// vite.config.ts (define) — no more hand-syncing a second copy of the version.
// The short commit hash disambiguates unreleased/dev builds.
export const APP_VERSION = __APP_VERSION__;
export const GIT_COMMIT = __GIT_COMMIT__;

/** e.g. "0.2.0+a1b2c3d", or plain "0.2.0" if the commit hash is unavailable. */
export const APP_VERSION_DISPLAY =
  GIT_COMMIT && GIT_COMMIT !== "unknown" ? `${APP_VERSION}+${GIT_COMMIT}` : APP_VERSION;
