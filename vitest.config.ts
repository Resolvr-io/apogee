import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  define: {
    __TX_MANIFEST_REGTEST__: false,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "playground/**/*.test.ts"],
  },
});
