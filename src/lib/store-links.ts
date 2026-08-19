// Where a user goes to see the published version and pick up an update.
//
// This is a link rather than an in-app check on purpose. `runtime.requestUpdateCheck()`
// exists, but its "throttled" result is not something worth explaining to a user,
// and the store auto-updates the extension anyway — so the honest affordance is
// "show me the published version", which the listing page does with no extra host
// permission.
export const STORE_LISTING_URL =
  "https://chromewebstore.google.com/detail/apogee/lbepaaibhmjmloagoggjhocdkelogamo";
