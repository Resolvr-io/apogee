// WebExtension namespace used throughout the codebase. Chrome's `chrome.*`
// returns promises when called without a callback — which is how this codebase
// already uses it — so this resolves to `chrome` and the whole tree can speak one
// name. Kept as an indirection rather than inlining `chrome`: it's the single
// place a namespace difference would be absorbed, and unpicking ~30 call sites
// buys nothing.
//
// Chrome-only API surfaces — `chrome.offscreen`, `chrome.sidePanel`, and the
// `chrome.runtime.getContexts` / `chrome.runtime.ContextType` context APIs — are
// deliberately NOT reached through this shim; they stay on `chrome.*` at their
// call sites. Compile-time type references (e.g. `chrome.storage.StorageChange`)
// also stay on `chrome.*`: they come from @types/chrome and have no runtime effect.
export const browser: typeof chrome =
  (globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome;
