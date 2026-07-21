import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";
import { APP_NAME, CONTENT_SECURITY_POLICY, ICONS, hostPermissions } from "./manifest.shared";

// Chrome MV3 manifest, authored via crxjs `defineManifest` (paths point at source
// files; crxjs rewrites them to hashed build outputs). A service-worker backend,
// a side panel, and a page provider front the Liquid wallet engine, which runs
// lwk_wasm in an offscreen document.
//
// The Firefox manifest lives in manifest.shared.ts (firefoxManifest) and is
// emitted by scripts/build-firefox.ts — crxjs is Chromium-only. Fields common to
// both targets come from manifest.shared.ts so there's a single source of truth.
export default defineManifest((env) => ({
  manifest_version: 3,
  name: APP_NAME,
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

  host_permissions: hostPermissions(env.mode),

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

  content_security_policy: CONTENT_SECURITY_POLICY,

  icons: ICONS,
}));
