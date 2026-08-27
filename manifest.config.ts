import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";
import { APP_NAME, CONTENT_SECURITY_POLICY, ICONS, hostPermissions } from "./manifest.shared";

// Chrome MV3 manifest, authored via crxjs `defineManifest` (paths point at source
// files; crxjs rewrites them to hashed build outputs). A service-worker backend,
// a side panel, and a page provider front the Liquid wallet engine, which runs
// lwk_wasm in an offscreen document.
//
// Static pieces (name, CSP, host permissions) come from manifest.shared.ts, which
// stays crxjs-free so plain tooling can read it.
export default defineManifest((env) => ({
  manifest_version: 3,
  name: APP_NAME,
  version: pkg.version,
  description: pkg.description,
  minimum_chrome_version: "116",

  // The Chrome Web Store listing's own public key, which forces a build to load
  // under the PUBLISHED extension id (lbepaaibhmjmloagoggjhocdkelogamo) rather
  // than one derived from whatever directory it was loaded from.
  //
  // Load-bearing for passkeys, not cosmetic. Ceremonies send no RP ID
  // (docs/passkey-unlock.md §4), so WebAuthn falls back to the caller's origin
  // and every credential is baked to `chrome-extension://<this id>`. Lose this
  // key from a shipped build and every enrolled passkey in the field orphans
  // permanently — WebAuthn has no delete, so users cannot even clear the dead
  // entries from their password manager. e2e/passkey-unlock.spec.ts asserts the
  // literal below still derives the published id, because nothing else would
  // notice: a fresh profile enrols and unlocks perfectly under a wrong id.
  //
  // Public half only — it is what determines the id, and it is already public in
  // every copy of the extension Chrome has ever distributed.
  //
  // DEVELOPMENT BUILDS DELIBERATELY OMIT IT. An unpacked build carrying the
  // store key loads under the store id, which means it shares
  // `chrome.storage.local` with the user's real installed wallet — a
  // wallet/reset or a restore-with-test-mnemonic in a dev build would then
  // destroy real funds' access — and it collides with the installed copy on
  // load. A dev build's path-derived id keeps its storage separate; the only
  // cost is that passkeys enrolled in a dev build do not carry to the store
  // build, which nothing needs.
  ...(env.mode === "development"
    ? {}
    : {
        key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvGe7xvLqXbkgKvJUjicNE0A0JYDcbEXPvM+2H2jcpGnDLhHtELaMk8lcK5SGkpxQGAyckmXHhFVBZA+ByktNZAGFbz0Gp+aOs/tfJoJbk3KiWYOf9L/bSk9b6xdCx1BKuW3jUPnCmieATS20fuj8ja5JBmrqlA15KFyv0c7A8IJTw2rcIjS4yMiDyTotc3VJexR70LZRH2Ua41Dk770bHpeaE+526Pm2b2esdwwMQCXQiLL0z3OhaVMB+qcKw3DRdbOxFClVGU+wHgZPjRpR7xNBEAUGnx/yWSPxi8dt1VS6oWOuZ8IOwDen6esmR2dr3y9RHXRSyC2uDY7eOHbNBQIDAQAB",
      }),

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
