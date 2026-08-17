import { execSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
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

// Mirror of the package.json `prebuild` refusal, enforced by Vite itself so a
// raw `vite build` (which skips pnpm hooks) is guarded too: any .env file Vite
// would load in production means VITE_* values — e.g. the enterprise OAuth
// client secret — get baked into the bundle. Development mode is exempt; dev
// builds with enterprise debugging are throwaway and never zipped.
function assertNoEnvFiles(): void {
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    if (fs.existsSync(name)) {
      throw new Error(
        `refusing to build: ${name} is present (credentials could ship in the bundle) — remove it or use the CI release build`,
      );
    }
  }
}

export default defineConfig(({ mode }) => {
  if (mode !== "development") assertNoEnvFiles();
  return {
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
  };
});
