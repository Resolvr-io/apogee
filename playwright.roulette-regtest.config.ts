import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "roulette-regtest.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 900_000,
  expect: { timeout: 45_000 },
  use: { actionTimeout: 30_000, trace: "retain-on-failure" },
});
