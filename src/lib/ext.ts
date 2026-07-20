// Cross-browser WebExtension namespace. Firefox exposes a promise-based `browser`
// global; Chrome has none, but its `chrome.*` returns promises when called without
// a callback — which is how this codebase already uses it. So this resolves to
// `chrome` on Chrome (behavior-identical to before) and to the native promisified
// `browser` on Firefox, with no polyfill dependency.
//
// Chrome-only API surfaces — `chrome.offscreen`, `chrome.sidePanel`, and the
// `chrome.runtime.getContexts` / `chrome.runtime.ContextType` context APIs — are
// deliberately NOT reached through this shim. They stay on `chrome.*` at their
// call sites and are forked per target as the Firefox port replaces the offscreen
// engine host and the side panel. Compile-time type references (e.g.
// `chrome.storage.StorageChange`) also stay on `chrome.*`: they come from
// @types/chrome and have no runtime effect.
export const browser: typeof chrome =
  (globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome;
