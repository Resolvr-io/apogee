import { loadEnv } from "vite";

// Manifest pieces shared by both targets, plus the Firefox manifest. This module
// is deliberately crxjs-free (and imports no JSON) so scripts/build-firefox.ts
// can import firefoxManifest() under Node's native TS runner without pulling in
// the Chromium-only crxjs plugin. package.json is read by each caller and the
// version/description are passed in.

export const APP_NAME = "Apogee";

// Debug builds only: a gitignored .env.local baking enterprise credentials also
// adds the two enterprise hosts (see src/lib/debug.ts). Store/CI builds have neither.
const hasEnterprise = (mode: string): boolean => {
  const e = loadEnv(mode, process.cwd(), "VITE_");
  return Boolean(e.VITE_BS_ENTERPRISE_CLIENT_ID && e.VITE_BS_ENTERPRISE_CLIENT_SECRET);
};

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

// Firefox MV3 manifest. Emitted (not fed to crxjs) by scripts/build-firefox.ts,
// which bundles the three manifest-referenced scripts to fixed, self-contained
// files (background.js / content.js / provider.js) — hence the flat js paths
// rather than the source paths crxjs rewrites for Chrome.
//
// Diverges from Chrome: no offscreen API on Firefox, so the engine host moves to
// the background event page (engine-host PR); the side panel becomes a
// sidebar_action; and sidePanel + offscreen are dropped from permissions.
export function firefoxManifest(mode: string, app: { version: string; description: string }) {
  return {
    manifest_version: 3,
    name: APP_NAME,
    version: app.version,
    description: app.description,
    // Add-on id (proposed default — change if a different AMO id is registered).
    // Required for stable storage + signing; strict_min_version 128 is the floor
    // for declarative content-script `world: "MAIN"`.
    browser_specific_settings: {
      gecko: { id: "apogee@resolvr.io", strict_min_version: "128.0" },
    },
    action: { default_title: "Open Apogee" },
    // A single self-contained classic script for now; the engine host lands later.
    background: { scripts: ["background.js"] },
    // Firefox uses a sidebar in place of Chrome's side panel.
    sidebar_action: {
      default_panel: "src/sidepanel/index.html",
      default_title: "Apogee",
      default_icon: ICONS,
    },
    permissions: ["storage", "alarms"],
    host_permissions: hostPermissions(mode),
    content_scripts: [
      // Bridge — ISOLATED world.
      {
        matches: ["<all_urls>"],
        js: ["content.js"],
        run_at: "document_start",
        all_frames: false,
      },
      // Page provider — MAIN world (Firefox 128+ supports declarative world).
      {
        matches: ["<all_urls>"],
        js: ["provider.js"],
        run_at: "document_start",
        all_frames: false,
        world: "MAIN",
      },
    ],
    content_security_policy: CONTENT_SECURITY_POLICY,
    icons: ICONS,
  };
}
