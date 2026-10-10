import { defineConfig } from "@playwright/test";

/**
 * Evidence suite for the public entry (the signed-out Landing and the two
 * pages its links lead to). Runs against the real local dev server — vite
 * with the cloudflare plugin, local D1 migrated and seeded by the repo's own
 * `pnpm dev` predev hook, fixture execution provider (never a paid service).
 *
 * Start the server, then run from the repo root:
 *   pnpm dev                     # terminal 1 (or already running)
 *   pnpm exec playwright test --config evidence/cogportal-entry/playwright.config.ts
 *
 * The server command below is a no-op when 5173 already answers
 * (reuseExistingServer), so an already-running `pnpm dev` is reused as-is.
 */
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [
    ["list"],
    ["json", { outputFile: "results/report.json" }],
  ],
  use: {
    baseURL: "http://localhost:5173",
    screenshot: "only-on-failure",
    trace: "off",
  },
  webServer: {
    command: "pnpm --filter @cogworks/portal dev",
    url: "http://localhost:5173/api/session",
    reuseExistingServer: true,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
});
