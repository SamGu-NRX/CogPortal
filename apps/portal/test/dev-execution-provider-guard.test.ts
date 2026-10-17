// The predev guard (scripts/dev-execution-provider-guard.mjs) decides from
// the vars wrangler will actually hand the Worker. Every case here runs the
// real CLI against a temporary portal directory with its own wrangler.jsonc
// and vars files, so the parsing under test is wrangler's own (dotenv), not a
// copy of it. The decision rule itself has one correct answer per input and
// is tested in isolation at the bottom.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { evaluateDevProviderGuard } from "../scripts/dev-execution-provider-guard.mjs";

const GUARD_PATH = fileURLToPath(new URL("../scripts/dev-execution-provider-guard.mjs", import.meta.url));
const PORTAL_ROOT = fileURLToPath(new URL("..", import.meta.url));

const STAGING_LIKE_CONFIG = JSON.stringify({
  name: "guard-test",
  main: "worker/index.ts",
  compatibility_date: "2026-07-01",
  vars: {
    EXECUTION_PROVIDER: "modal",
    MODAL_RUNNER_URL: "https://staging.example/cogworks-runner-submit-job.modal.run",
  },
  env: {
    production: {
      vars: {
        EXECUTION_PROVIDER: "modal",
        MODAL_RUNNER_URL: "https://production.example/cogworks-runner-submit-job.modal.run",
      },
    },
  },
});

function portal(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dev-guard-"));
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  return dir;
}

function runGuard(root: string, extraEnv: Record<string, string> = {}) {
  // Hermetic: none of the caller's CLOUDFLARE_* or provider settings leak in.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("CLOUDFLARE_") || key === "EXECUTION_PROVIDER") continue;
    env[key] = value;
  }
  return spawnSync(process.execPath, [GUARD_PATH], {
    encoding: "utf8",
    cwd: root,
    env: { ...env, COGPORTAL_DEV_GUARD_ROOT: root, ...extraEnv },
  });
}

function assertRefused(run: ReturnType<typeof runGuard>, why: string) {
  assert.equal(run.status, 1, `${why}: expected a refusal, got exit ${run.status}\n${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /pnpm dev blocked/, why);
}

function assertAllowed(run: ReturnType<typeof runGuard>, why: string) {
  assert.equal(run.status, 0, `${why}: expected the boot to pass, got exit ${run.status}\n${run.stdout}${run.stderr}`);
}

test("an unquoted inline comment does not hide modal from the guard", () => {
  // dotenv ends an unquoted value at "#", so the Worker receives "modal".
  // The guard's old parser only cut at whitespace-then-#, read
  // "modal#comment", and let the boot through.
  const run = runGuard(portal({ "wrangler.jsonc": STAGING_LIKE_CONFIG, ".dev.vars": "EXECUTION_PROVIDER=modal#comment\n" }));
  assertRefused(run, "modal#comment");
  assert.match(run.stderr, /resolves to "modal"/);
});

test("the guard reads values exactly as wrangler hands them to the Worker", () => {
  for (const line of [
    'EXECUTION_PROVIDER="fixture"',
    "EXECUTION_PROVIDER='fixture'",
    "EXECUTION_PROVIDER=fixture # the safe one",
    "EXECUTION_PROVIDER=fixture#no-space",
    "export EXECUTION_PROVIDER=fixture",
  ]) {
    assertAllowed(runGuard(portal({ "wrangler.jsonc": STAGING_LIKE_CONFIG, ".dev.vars": `${line}\n` })), line);
  }
});

test("a later duplicate key wins, the way dotenv resolves it", () => {
  const run = runGuard(
    portal({
      "wrangler.jsonc": STAGING_LIKE_CONFIG,
      ".dev.vars": 'EXECUTION_PROVIDER="fixture"\nEXECUTION_PROVIDER="modal"\n',
    }),
  );
  assertRefused(run, "fixture then modal");
});

test("no vars file inherits the staging config and refuses", () => {
  assertRefused(runGuard(portal({ "wrangler.jsonc": STAGING_LIKE_CONFIG })), "no .dev.vars");
});

test("without a .dev.vars, wrangler's .env fallback is what counts", () => {
  assertAllowed(
    runGuard(portal({ "wrangler.jsonc": STAGING_LIKE_CONFIG, ".env": "EXECUTION_PROVIDER=fixture\n" })),
    ".env fallback",
  );
});

test("CLOUDFLARE_ENV selects that environment's vars file, and the guard follows it", () => {
  const root = portal({
    "wrangler.jsonc": STAGING_LIKE_CONFIG,
    ".dev.vars": 'EXECUTION_PROVIDER="fixture"\n',
    ".dev.vars.production": 'EXECUTION_PROVIDER="modal"\n',
  });
  assertAllowed(runGuard(root), "no environment selected");
  assertRefused(runGuard(root, { CLOUDFLARE_ENV: "production" }), "CLOUDFLARE_ENV=production from the shell");
  // Vite's loadEnv reads CLOUDFLARE_ENV from a .env file as well.
  writeFileSync(join(root, ".env"), "CLOUDFLARE_ENV=production\n");
  assertRefused(runGuard(root), "CLOUDFLARE_ENV=production from .env");
});

test("anything other than an explicit fixture or opted-in modal refuses", () => {
  for (const devVars of [
    'EXECUTION_PROVIDER=""\n',
    'EXECUTION_PROVIDER="Fixture"\n',
    'EXECUTION_PROVIDER="fixture "\n',
    'EXECUTION_PROVIDER="local"\n',
  ]) {
    assertRefused(runGuard(portal({ "wrangler.jsonc": STAGING_LIKE_CONFIG, ".dev.vars": devVars })), devVars.trim());
  }
  const unset = JSON.stringify({ name: "guard-test", main: "worker/index.ts", compatibility_date: "2026-07-01" });
  assertRefused(runGuard(portal({ "wrangler.jsonc": unset })), "provider set nowhere");
});

test("modal passes only with an explicit opt-in", () => {
  for (const value of ["1", "true", "TRUE"]) {
    assertAllowed(
      runGuard(
        portal({
          "wrangler.jsonc": STAGING_LIKE_CONFIG,
          ".dev.vars": `EXECUTION_PROVIDER="modal"\nALLOW_MODAL_EXECUTION_IN_DEV="${value}"\n`,
        }),
      ),
      `opt-in ${value}`,
    );
  }
  for (const value of ["", "0", "false", "enabled", "1#"]) {
    assertRefused(
      runGuard(
        portal({
          "wrangler.jsonc": STAGING_LIKE_CONFIG,
          ".dev.vars": `EXECUTION_PROVIDER="modal"\nALLOW_MODAL_EXECUTION_IN_DEV="${value}"\n`,
        }),
      ),
      `opt-in ${JSON.stringify(value)}`,
    );
  }
});

test("the repository's own config with the documented .dev.vars.example passes", () => {
  const root = mkdtempSync(join(tmpdir(), "dev-guard-real-"));
  copyFileSync(join(PORTAL_ROOT, "wrangler.jsonc"), join(root, "wrangler.jsonc"));
  copyFileSync(join(PORTAL_ROOT, ".dev.vars.example"), join(root, ".dev.vars"));
  assertAllowed(runGuard(root), "documented setup");
  // And the same config with no .dev.vars is the staging inheritance the
  // guard exists for.
  const bare = mkdtempSync(join(tmpdir(), "dev-guard-real-"));
  copyFileSync(join(PORTAL_ROOT, "wrangler.jsonc"), join(bare, "wrangler.jsonc"));
  assertRefused(runGuard(bare), "repository config without .dev.vars");
});

test("a config wrangler cannot read refuses rather than guessing", () => {
  const run = runGuard(portal({ "wrangler.jsonc": "{ not json" }));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Refusing to start/);
});

test("the decision rule: only fixture, or modal with the opt-in", () => {
  assert.equal(evaluateDevProviderGuard({ EXECUTION_PROVIDER: "fixture" }).allowed, true);
  assert.equal(evaluateDevProviderGuard({ EXECUTION_PROVIDER: "modal" }).allowed, false);
  assert.equal(evaluateDevProviderGuard({ EXECUTION_PROVIDER: "modal", ALLOW_MODAL_EXECUTION_IN_DEV: "1" }).optIn, true);
  // The opt-in licenses modal and nothing else.
  assert.equal(evaluateDevProviderGuard({ EXECUTION_PROVIDER: "modal#x", ALLOW_MODAL_EXECUTION_IN_DEV: "1" }).allowed, false);
  assert.equal(evaluateDevProviderGuard({}).allowed, false);
});
