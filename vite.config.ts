import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";
import pkg from "./package.json";

// The short commit hash disambiguates unreleased/dev builds in the UI (Settings
// → Version). Falls back to "unknown" for a build with no .git available (e.g.
// from a source zip), rather than failing the build.
function getCommitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

// crxjs emits web_accessible_resources with use_dynamic_url: false — stable
// chrome-extension:// URLs any site can probe to fingerprint the installed
// extension. Flip it post-build so resource URLs are per-instance (honored on
// Chromium 130+; older versions ignore the key and fall back to stable URLs).
function warUseDynamicUrl(): Plugin {
  let outDir = "dist";
  return {
    name: "apogee-war-use-dynamic-url",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const manifestPath = path.resolve(outDir, "manifest.json");
      let built: { web_accessible_resources?: Array<Record<string, unknown>> };
      try {
        built = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch {
        return; // no manifest in this build (e.g. playground) — nothing to do
      }
      const wars = built.web_accessible_resources;
      if (!Array.isArray(wars)) return;
      if (!wars.some((war) => war.use_dynamic_url !== true)) return;
      for (const war of wars) war.use_dynamic_url = true;
      fs.writeFileSync(manifestPath, JSON.stringify(built, null, 2) + "\n");
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // package.json is the single source of truth for the app version — never
  // hand-duplicate it. Read by src/version.ts at build time.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_COMMIT__: JSON.stringify(getCommitHash()),
    // Chrome/crxjs build. The Firefox target (scripts/build-firefox.ts) sets true.
    __FIREFOX__: JSON.stringify(false),
  },
  plugins: [
    react(),
    tailwindcss(),
    wasm(),
    topLevelAwait(),
    crx({ manifest }),
    warUseDynamicUrl(),
  ],
  build: {
    target: "esnext",
    // Vite's module-preload polyfill injects a helper that references `window`
    // and `document` — globals that don't exist in the MV3 service worker.
    // Module preloading is pointless in an extension (all assets are bundled
    // locally), so disable it entirely.
    modulePreload: false,
    rollupOptions: {
      // HTML pages not referenced by the manifest (offscreen is created
      // at runtime via chrome.offscreen; prompt is opened as a popup window).
      input: {
        offscreen: "src/offscreen/offscreen.html",
        prompt: "src/prompt/prompt.html",
        scanner: "src/scanner/scanner.html",
        jade: "src/jade/jade.html",
        guide: "src/guide/guide.html",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    // crxjs HMR uses a dedicated websocket port.
    hmr: { port: 5174 },
  },
});
