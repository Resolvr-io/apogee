import { execSync } from "node:child_process";
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
