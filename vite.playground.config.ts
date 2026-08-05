import { defineConfig } from "vite";

export default defineConfig({
  root: "playground/liquid-provider",
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    hmr: false,
  },
});
