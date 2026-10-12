// The real-journeys harness (tools/portal-real-journeys) must never boot a
// Worker that can reach a real provider. Its seal reads the vars wrangler
// will actually hand the Worker and refuses the boot otherwise. These tests
// live with the portal's suite so CI runs them; the harness itself does not
// run in CI.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PROFILE_EXPECTATIONS,
  bindingViolations,
  deployedIdentities,
  effectivePreviewVars,
  isLoopbackUrl,
  profileVars,
  readPortalConfig,
  runWranglerConfig,
  sealViolations,
} from "../../../tools/portal-real-journeys/stack/seal.mjs";
import { PROVIDER_URLS } from "../../../tools/portal-real-journeys/stack/doubles.mjs";

const PORTAL_DIR = fileURLToPath(new URL("..", import.meta.url));
const BASE = "http://127.0.0.1:8810";

async function deployed() {
  return deployedIdentities(await readPortalConfig(PORTAL_DIR));
}

test("loopback means a loopback host over http(s), nothing else", () => {
  for (const url of ["http://127.0.0.1:8823", "http://localhost:1", "http://[::1]:9/x", "https://127.0.0.1"]) {
    assert.equal(isLoopbackUrl(url), true, url);
  }
  for (const url of [
    "https://samgu-nrx--cogworks-runner-submit-job.modal.run",
    "https://discord.com/api",
    "http://127.0.0.1.nip.io",
    "http://10.0.0.1",
    "file:///etc/passwd",
    "127.0.0.1:8823",
    "",
  ]) {
    assert.equal(isLoopbackUrl(url), false, url);
  }
});

test("the previous production-refusal boot would now be refused", async () => {
  // What the old supervisor produced: the checkout's wrangler.jsonc (staging
  // vars at the top level) with this .dev.vars beside it. It turned modal on
  // and never replaced the staging MODAL_RUNNER_URL.
  const dir = mkdtempSync(join(tmpdir(), "rj-seal-"));
  copyFileSync(join(PORTAL_DIR, "wrangler.jsonc"), join(dir, "wrangler.jsonc"));
  writeFileSync(
    join(dir, ".dev.vars"),
    [
      'ENVIRONMENT="production"',
      'DEV_AUTH="disabled"',
      'EXECUTION_PROVIDER="modal"',
      `BETTER_AUTH_URL="${BASE}"`,
      `PUBLIC_ORIGIN="${BASE}"`,
      'GITHUB_CLIENT_ID="Iv23liATo0NWltd5sZgi"',
      'GITHUB_CLIENT_SECRET="rj-config-test-only"',
      'RUNNER_SIGNING_SECRET="rj-local-runner-signing-secret-0001"',
    ].join("\n"),
  );
  const { vars } = await effectivePreviewVars({ portalDir: PORTAL_DIR, builtConfigPath: join(dir, "wrangler.jsonc") });
  assert.equal(vars.MODAL_RUNNER_URL, "https://samgu-nrx--cogworks-runner-submit-job.modal.run");
  const violations = sealViolations(vars, { deployed: await deployed() });
  assert.ok(violations.some((line) => line.startsWith("MODAL_RUNNER_URL=https://samgu-nrx")), violations.join("\n"));
  assert.ok(violations.some((line) => line.startsWith("GITHUB_CLIENT_ID carries a deployed value")), violations.join("\n"));
});

test("a build whose .dev.vars was scrubbed boots on staging vars, and is refused", async () => {
  // The old harness ran scripts/scrub-dist-secrets.mjs after building, which
  // deletes the built .dev.vars, so the preview ran on wrangler.jsonc alone.
  const dir = mkdtempSync(join(tmpdir(), "rj-seal-"));
  copyFileSync(join(PORTAL_DIR, "wrangler.jsonc"), join(dir, "wrangler.jsonc"));
  const { vars } = await effectivePreviewVars({ portalDir: PORTAL_DIR, builtConfigPath: join(dir, "wrangler.jsonc") });
  const violations = sealViolations(vars, { deployed: await deployed(), expected: PROFILE_EXPECTATIONS.fixture });
  assert.ok(violations.some((line) => line.includes("DISCORD_API_BASE_URL is unset")), violations.join("\n"));
  assert.ok(violations.some((line) => line.startsWith("EXECUTION_PROVIDER=\"modal\", expected \"fixture\"")), violations.join("\n"));
});

test("every harness profile's run config resolves sealed through wrangler", async () => {
  const portalConfig = await readPortalConfig(PORTAL_DIR);
  const known = deployedIdentities(portalConfig);
  for (const profile of Object.keys(PROFILE_EXPECTATIONS)) {
    const dir = mkdtempSync(join(tmpdir(), "rj-seal-"));
    const config = runWranglerConfig({
      portalConfig,
      portalDir: PORTAL_DIR,
      vars: profileVars(profile, { base: BASE, providerUrls: PROVIDER_URLS }),
    });
    assert.deepEqual(bindingViolations(config), [], profile);
    writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify(config));
    const { vars } = await effectivePreviewVars({ portalDir: PORTAL_DIR, builtConfigPath: join(dir, "wrangler.jsonc") });
    assert.deepEqual(sealViolations(vars, { deployed: known, expected: PROFILE_EXPECTATIONS[profile] }), [], profile);
  }
});

test("a stray .dev.vars beside the run config cannot unseal it", async () => {
  // wrangler layers .dev.vars over config vars; the seal reads the result.
  const portalConfig = await readPortalConfig(PORTAL_DIR);
  const dir = mkdtempSync(join(tmpdir(), "rj-seal-"));
  const config = runWranglerConfig({
    portalConfig,
    portalDir: PORTAL_DIR,
    vars: profileVars("fixture", { base: BASE, providerUrls: PROVIDER_URLS }),
  });
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify(config));
  writeFileSync(join(dir, ".dev.vars"), "DISCORD_API_BASE_URL=https://discord.com/api\n");
  const { vars } = await effectivePreviewVars({ portalDir: PORTAL_DIR, builtConfigPath: join(dir, "wrangler.jsonc") });
  assert.deepEqual(sealViolations(vars, { deployed: deployedIdentities(portalConfig) }), [
    "DISCORD_API_BASE_URL=https://discord.com/api is not loopback",
  ]);
});

test("the run config carries no routes, no production environment and no remote binding", async () => {
  const portalConfig = await readPortalConfig(PORTAL_DIR);
  const config = runWranglerConfig({
    portalConfig,
    portalDir: PORTAL_DIR,
    vars: profileVars("fixture", { base: BASE, providerUrls: PROVIDER_URLS }),
  }) as Record<string, unknown>;
  for (const key of ["routes", "env", "triggers", "workers_dev"]) assert.equal(config[key], undefined, key);
  const ids = JSON.stringify(config);
  for (const value of deployedIdentities(portalConfig)) assert.equal(ids.includes(value), false, value);
  assert.ok(!ids.includes("b7e9e560-c32c-435e-9bfc-b82da43b27f4"), "the deployed D1 id");
  assert.ok(!ids.includes("cogportal-artifacts"), "a deployed R2 bucket");
  assert.deepEqual(
    bindingViolations({ ...config, d1_databases: [{ binding: "DB", remote: true }] }),
    ["binding DB is remote"],
  );
});
