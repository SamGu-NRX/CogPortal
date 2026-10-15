import { defineConfig } from "@playwright/test";

// One shared local app (booted by stack/boot.sh, port JOURNEYS_PORT, default
// 5199), so the tests run serially and each reads the roster through the API
// instead of assuming a private world. JOURNEYS_REUSE_STACK=0 forces this run
// to boot its own stack — on a shared checkout machine, a reused server is
// somebody else's world.
const port = Number(process.env.JOURNEYS_PORT ?? 5199);

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "sh stack/boot.sh",
    url: `http://localhost:${port}/api/session`,
    reuseExistingServer: process.env.JOURNEYS_REUSE_STACK === "0" ? false : true,
    timeout: 240_000,
  },
});
