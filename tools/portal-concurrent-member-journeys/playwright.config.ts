import { defineConfig } from "@playwright/test";

// One shared local app (booted by stack/boot.sh on port 5199), so the tests
// run serially and each reads the roster through the API instead of assuming
// a private world.
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:5199",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "sh stack/boot.sh",
    url: "http://localhost:5199/api/session",
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
