import { loadEnv } from "vite";

// Manifest pieces shared across the build. Kept crxjs-free (and importing no
// JSON) so it can be read by plain Node tooling as well as the Chrome build.
// package.json is read by the caller and the version/description passed in.

export const APP_NAME = "Apogee";

// Debug builds only: a gitignored .env.local baking enterprise credentials also
// adds the two enterprise hosts (see src/lib/debug.ts). Store/CI builds have neither.
const hasEnterprise = (mode: string): boolean => {
  const e = loadEnv(mode, process.cwd(), "VITE_");
  return Boolean(e.VITE_BS_ENTERPRISE_CLIENT_ID && e.VITE_BS_ENTERPRISE_CLIENT_SECRET);
};

// NOTE: passkeys need no host permission at all. Ceremonies send no RP ID, so
// WebAuthn binds credentials to the extension's own origin — nothing is being
// claimed that needs granting (docs/passkey-unlock.md §4). An earlier design
// claimed resolvr.io via an optional host permission; on Chrome that claim is
// accepted and then never dispatched from a side panel, which is the whole
// reason this is gone. Do not reintroduce it without reading §4.

// Esplora endpoints (extension-origin fetch is CORS-exempt) + the localhost
// gateway for contract reads during dev. Identical across targets.
export function hostPermissions(mode: string): string[] {
  return [
    ...(hasEnterprise(mode)
      ? ["https://enterprise.blockstream.info/*", "https://login.blockstream.com/*"]
      : []),
    "https://waterfalls.liquidwebwallet.org/*", // waterfalls scan server (default sync)
    "https://*.blockstream.info/*", // plain Esplora + asset registry (assets.blockstream.info)
    "https://blockstream.info/*", // plain Esplora (override)
    "https://liquid.network/*", // alternative Esplora provider (override)
    // Fiat price sources (lwk PricesFetcher takes the median of those reachable).
    "https://api.coinbase.com/*",
    "https://api.kraken.com/*",
    "https://api.coingecko.com/*",
    "https://api.coinpaprika.com/*",
    "https://blockchain.info/*",
    // Also a fallbackRate source: quotes every FIAT_OPTIONS currency in one
    // keyless call, so it widens the median's margin when CoinGecko is rate-limited.
    "https://mempool.space/*",
    // SideSwap dealer (instant swaps): WebSocket (wss://) is covered by the
    // https host permission in Chrome MV3.
    "https://*.sideswap.io/*",
    // Release feed for the Settings "Check for updates" link — one request to
    // the latest-release endpoint, only when the user presses it.
    "https://api.github.com/*",
    // Dev-only: localhost contract gateway / regtest Esplora. Excluded from
    // production builds so the shipped extension can't reach loopback.
    ...(mode === "development" ? ["http://localhost/*", "http://127.0.0.1/*"] : []),
  ];
}

export const ICONS = {
  16: "icons/icon16.png",
  32: "icons/icon32.png",
  48: "icons/icon48.png",
  128: "icons/icon128.png",
};

// wasm-unsafe-eval lets lwk_wasm instantiate under MV3 CSP without eval.
export const CONTENT_SECURITY_POLICY = {
  extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
};
