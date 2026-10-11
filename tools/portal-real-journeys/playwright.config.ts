import { defineConfig } from "@playwright/test";

/**
 * Real-journeys suite for the CogPortal web app.
 *
 * What "real" means here: the browser talks to one origin served the way
 * deployment serves it — the built SPA and the built Worker through the
 * repo's own Cloudflare Vite preview path — over a real local D1 (every
 * migration applied, the VISION26 seed applied) with every provider boundary
 * present as a labelled local double (GitHub REST, GitHub OAuth, Discord,
 * Modal runner). Nothing under test is stubbed at the Playwright layer:
 * journey shaping (delays, drops, duplicates, refreshes, double submits)
 * happens on the wire, via the stack supervisor's proxy and control API.
 *
 * The stack supervisor (stack/stack.mjs) is this file's only webServer. It
 * builds the SPA, resets and seeds D1, boots the Worker, starts the doubles,
 * and fronts everything with the shaping proxy. Tests rendezvous with it on
 * /__stack/health and drive it on /__control/* and /__proxy/*.
 */
export default defineConfig({
  testDir: "./journeys",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: "./test-results/artifacts",
  reporter: [["list"], ["html", { outputFolder: "./test-results/report", open: "never" }]],
  use: {
    // The browser only ever sees the shaping proxy; the Worker is upstream.
    baseURL: "http://127.0.0.1:8810",
    headless: true,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: { mode: "retain-on-failure", size: { width: 1440, height: 900 } },
  },
  webServer: {
    command: "node stack/stack.mjs",
    url: "http://127.0.0.1:8810/__stack/health",
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
