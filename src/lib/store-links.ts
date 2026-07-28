// Where a user goes to see the published version and pick up an update. Resolved
// at build time so each target links to its own listing — a Firefox user is never
// sent to the Chrome Web Store.
//
// This is a link rather than an in-app check on purpose. `runtime.requestUpdateCheck()`
// exists only on Chromium (Firefox does not implement it), so an in-app check would
// be a Chrome-only feature, and its "throttled" result is not something worth
// explaining to a user. Both stores auto-update the extension anyway, so the honest
// affordance is "show me the published version" — which the listing page does, for
// both browsers, with no extra host permission.
export const STORE_LISTING_URL = __FIREFOX__
  ? "https://addons.mozilla.org/firefox/addon/apogee-wallet/"
  : "https://chromewebstore.google.com/detail/apogee/lbepaaibhmjmloagoggjhocdkelogamo";
