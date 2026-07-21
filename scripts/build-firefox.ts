// Firefox build orchestrator. crxjs (the Chrome build) is Chromium-only, so the
// Firefox target is produced here with plain Vite:
//   1. one Vite build for the extension's HTML pages            → dist-firefox/src/…
//   2. three single-file IIFE builds for the manifest-referenced scripts that
//      must be self-contained — Firefox content scripts can't ES-import at
//      runtime, and the background is loaded as a classic script → *.js at root
//   3. emit dist-firefox/manifest.json from firefoxManifest()
//
// The Chrome-only offscreen page is excluded (no chrome.offscreen on Firefox).
// Run via Node's native TS support: `node scripts/build-firefox.ts`
// (pnpm build:firefox).
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, type InlineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import pkg from "../package.json" with { type: "json" };
import { firefoxManifest } from "../manifest.shared.ts";

const abs = (p: string): string => fileURLToPath(new URL(`../${p}`, import.meta.url));
const outDir = abs("dist-firefox");
const mode = process.env.MODE ?? "production";

function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

const shared: InlineConfig = {
  configFile: false,
  root: abs(""),
  mode,
  resolve: { alias: { "@": abs("src") } },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_COMMIT__: JSON.stringify(gitCommit()),
    __FIREFOX__: JSON.stringify(true),
  },
};

// HTML pages (React/CSS/wasm handled by Vite), output preserving the src/… path
// so runtime browser.runtime.getURL("src/…/*.html") calls resolve.
async function buildPages(): Promise<void> {
  await build({
    ...shared,
    plugins: [react(), tailwindcss(), wasm(), topLevelAwait()],
    build: {
      outDir,
      emptyOutDir: true,
      target: "esnext",
      rollupOptions: {
        input: {
          sidepanel: abs("src/sidepanel/index.html"),
          prompt: abs("src/prompt/prompt.html"),
          scanner: abs("src/scanner/scanner.html"),
          jade: abs("src/jade/jade.html"),
          guide: abs("src/guide/guide.html"),
        },
      },
    },
  });
}

// A wasm-free content script → one self-contained IIFE file at the dist root.
// Firefox content scripts can't ES-import at runtime, so no code-splitting: plain
// rollupOptions (not lib mode) with a single input externalizes nothing. (The
// background is NOT built this way — it hosts the wasm engine; see buildBackground.)
async function buildScript(name: string, entry: string): Promise<void> {
  await build({
    ...shared,
    build: {
      outDir,
      emptyOutDir: false,
      target: "esnext",
      rollupOptions: {
        input: abs(entry),
        output: {
          format: "iife",
          entryFileNames: `${name}.js`,
          name: `apogee_${name}`,
          inlineDynamicImports: true,
        },
      },
    },
  });
}

// The background hosts the lwk_wasm engine on Firefox (no offscreen API), so —
// unlike the content scripts — it's built as an ES module with the wasm +
// top-level-await plugins, code-split so the ~10 MB wasm loads lazily on the first
// engine call. The manifest declares `background.type: "module"` to match.
async function buildBackground(): Promise<void> {
  await build({
    ...shared,
    plugins: [wasm(), topLevelAwait()],
    build: {
      outDir,
      emptyOutDir: false,
      target: "esnext",
      rollupOptions: {
        input: abs("src/background/index.ts"),
        output: {
          format: "es",
          entryFileNames: "background.js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  });
}

async function main(): Promise<void> {
  await buildPages();
  await buildBackground();
  await buildScript("content", "src/content/content.ts");
  await buildScript("provider", "src/provider/liquid-provider.ts");
  writeFileSync(
    abs("dist-firefox/manifest.json"),
    JSON.stringify(
      firefoxManifest(mode, { version: pkg.version, description: pkg.description }),
      null,
      2,
    ) + "\n",
  );
  console.log(`[apogee] Firefox build → dist-firefox (mode=${mode})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
