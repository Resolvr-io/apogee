import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

// MV3 manifest, authored in TS so paths point at source files; crxjs
// rewrites them to the hashed build outputs. A service-worker backend, a
// side panel, and a page provider front the Liquid wallet engine, which
// runs lwk_wasm in an offscreen document.
export default defineManifest((env) => ({
  manifest_version: 3,
  name: "Apogee",
  version: pkg.version,
  description: pkg.description,
  minimum_chrome_version: "116",

  action: { default_title: "Open Apogee" },

  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },

  side_panel: {
    default_path: "src/sidepanel/index.html",
  },

  permissions: ["storage", "sidePanel", "alarms", "offscreen"],

  // Esplora endpoints (extension-origin fetch is CORS-exempt) + the
  // localhost gateway for contract reads during dev.
  host_permissions: [
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
    ...(env.mode === "development" ? ["http://localhost/*", "http://127.0.0.1/*"] : []),
  ],

  content_scripts: [
    // Bridge — ISOLATED world, can use chrome.runtime.
    {
      matches: ["<all_urls>"],
      js: ["src/content/content.ts"],
      run_at: "document_start",
      all_frames: false,
    },
    // Page provider — MAIN world, defines window.apogee; talks to the
    // bridge via window.postMessage. Chrome auto-injects it (no manual
    // <script> tag), and crxjs transpiles it as a real build input.
    {
      matches: ["<all_urls>"],
      js: ["src/provider/liquid-provider.ts"],
      run_at: "document_start",
      all_frames: false,
      world: "MAIN",
    },
  ],

  // wasm-unsafe-eval lets lwk_wasm instantiate under MV3 CSP without eval.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },

  icons: {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  },
}));
