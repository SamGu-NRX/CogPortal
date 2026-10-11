import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// One attempt per case: a retry would blur which failure a receipt witnessed
// (the plan counts a flake as a failure, so hiding one behind a retry is worse
// than failing loudly). One worker: the journeys share the stack this config's
// globalSetup boots, and several of them shape the same Worker's network.
export default defineConfig({
  testDir: "journeys",
  globalSetup: fileURLToPath(new URL("./support/setup.ts", import.meta.url)),
  globalTeardown: fileURLToPath(new URL("./support/teardown.ts", import.meta.url)),
  workers: 1,
  retries: 0,
  fullyParallel: false,
  timeout: 900_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["json", { outputFile: "results/journeys.json" }]],
  outputDir: "results/test-artifacts",
  use: {
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
});
