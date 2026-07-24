import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone vitest config — deliberately NOT extending vite.config.ts, whose
// crx() plugin builds the whole MV3 extension and warns about MAIN-world HMR.
// The manifest core (src/manifest/*) is plain TypeScript with no Chrome or wasm
// dependency, so unit tests need only the `@` alias.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
