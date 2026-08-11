import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "lending-regtest.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 600_000,
  expect: { timeout: 30_000 },
  use: { trace: "retain-on-failure" },
});
