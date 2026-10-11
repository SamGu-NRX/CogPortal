// Covers the predev guard (scripts/dev-execution-provider-guard.mjs): the
// .dev.vars parser, the resolution of the effective EXECUTION_PROVIDER for a
// dev boot (.dev.vars per key, else wrangler.jsonc top-level vars), the four
// allow/refuse decisions the guard exists for, and the CLI's exit behavior
// against hermetic fixture files.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  evaluateDevProviderGuard,
  parseDevVars,
  parseJsonc,
} from "../scripts/dev-execution-provider-guard.mjs";

test("parseDevVars skips comments and blank lines and strips quotes", () => {
  const vars = parseDevVars(
    [
      "# leading comment",
      "",
      "  # indented comment",
      'EXECUTION_PROVIDER="modal"',
      "ALLOW_MODAL_EXECUTION_IN_DEV = '1'",
      "PLAIN=value",
      "export EXPORTED=yes",
      'QUOTED_HASH="keep # this"',
      "TRAILING_COMMENT=value # not this part",
      "SPACED = spaced value ",
      "",
    ].join("\n"),
  );
  assert.deepEqual(vars, {
    EXECUTION_PROVIDER: "modal",
    ALLOW_MODAL_EXECUTION_IN_DEV: "1",
    PLAIN: "value",
    EXPORTED: "yes",
    QUOTED_HASH: "keep # this",
    TRAILING_COMMENT: "value",
    SPACED: "spaced value",
  });
});

test("parseDevVars handles CRLF files", () => {
  assert.deepEqual(parseDevVars('A="1"\r\nB=2\r\n'), { A: "1", B: "2" });
});

test("parseJsonc strips comments and trailing commas", () => {
  const config = parseJsonc(
    `{
      // top-level vars
      "name": "cogportal", /* block */
      "vars": {
        "EXECUTION_PROVIDER": "modal", // after a value
        "URL": "https://example.modal.run",
      },
    }`,
  );
  assert.deepEqual(config.vars, {
    EXECUTION_PROVIDER: "modal",
    URL: "https://example.modal.run",
  });
});

const MODAL_CONFIG = {
  EXECUTION_PROVIDER: "modal",
  MODAL_RUNNER_URL: "https://staging.example/cogworks-runner-submit-job.modal.run",
};

test("no .dev.vars with top-level modal refuses", () => {
  const result = evaluateDevProviderGuard({ devVars: {}, devVarsPresent: false, configVars: MODAL_CONFIG });
  assert.equal(result.allowed, false);
  assert.match(result.message, /EXECUTION_PROVIDER="fixture"/);
  assert.match(result.message, /ALLOW_MODAL_EXECUTION_IN_DEV="1"/);
});

test("modal in .dev.vars without the opt-in refuses", () => {
  const result = evaluateDevProviderGuard({
    devVars: { EXECUTION_PROVIDER: "modal" },
    devVarsPresent: true,
    configVars: MODAL_CONFIG,
  });
  assert.equal(result.allowed, false);
});

test("modal with the explicit opt-in in .dev.vars passes", () => {
  for (const value of ["1", "true", "TRUE"]) {
    const result = evaluateDevProviderGuard({
      devVars: { EXECUTION_PROVIDER: "modal", ALLOW_MODAL_EXECUTION_IN_DEV: value },
      devVarsPresent: true,
      configVars: MODAL_CONFIG,
    });
    assert.equal(result.allowed, true, `opt-in ${JSON.stringify(value)} must grant`);
    assert.equal(result.optIn, true);
  }
});

test(".dev.vars overriding to the fixture provider passes without any opt-in", () => {
  const result = evaluateDevProviderGuard({
    devVars: { EXECUTION_PROVIDER: "fixture" },
    devVarsPresent: true,
    configVars: MODAL_CONFIG,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.optIn, undefined);
});

test("falsy or unrecognized opt-in values grant nothing", () => {
  for (const value of ["", "0", "false", "enabled"]) {
    const result = evaluateDevProviderGuard({
      devVars: { EXECUTION_PROVIDER: "modal", ALLOW_MODAL_EXECUTION_IN_DEV: value },
      devVarsPresent: true,
      configVars: MODAL_CONFIG,
    });
    assert.equal(result.allowed, false, `opt-in ${JSON.stringify(value)} must not grant`);
  }
});

test("a .dev.vars without EXECUTION_PROVIDER falls through to the config value", () => {
  const result = evaluateDevProviderGuard({
    devVars: { BETTER_AUTH_SECRET: "x" },
    devVarsPresent: true,
    configVars: MODAL_CONFIG,
  });
  assert.equal(result.allowed, false);
});

test("a boot with no provider configured anywhere is not blocked", () => {
  const result = evaluateDevProviderGuard({ devVars: {}, devVarsPresent: false, configVars: {} });
  assert.equal(result.allowed, true);
  assert.equal(result.provider, undefined);
});

const GUARD_PATH = fileURLToPath(new URL("../scripts/dev-execution-provider-guard.mjs", import.meta.url));

function runGuard(devVarsText, wranglerText) {
  const dir = mkdtempSync(join(tmpdir(), "dev-guard-"));
  const devVarsPath = join(dir, ".dev.vars");
  const wranglerPath = join(dir, "wrangler.jsonc");
  if (devVarsText !== null) writeFileSync(devVarsPath, devVarsText);
  writeFileSync(wranglerPath, wranglerText);
  return spawnSync(process.execPath, [GUARD_PATH], {
    encoding: "utf8",
    env: {
      ...process.env,
      COGPORTAL_DEV_GUARD_DEV_VARS: devVarsText === null ? join(dir, "absent") : devVarsPath,
      COGPORTAL_DEV_GUARD_WRANGLER_JSONC: wranglerPath,
    },
  });
}

test("the guard CLI refuses a modal boot with no .dev.vars", () => {
  const run = runGuard(null, '{ "vars": { "EXECUTION_PROVIDER": "modal" } }');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /EXECUTION_PROVIDER="fixture"/);
});

test("the guard CLI allows a modal boot that opted in", () => {
  const run = runGuard(
    'EXECUTION_PROVIDER="modal"\nALLOW_MODAL_EXECUTION_IN_DEV="1"\n',
    '{ "vars": { "EXECUTION_PROVIDER": "modal" } }',
  );
  assert.equal(run.status, 0);
});

test("the guard CLI allows a fixture boot", () => {
  const run = runGuard('EXECUTION_PROVIDER="fixture"\n', '{ "vars": { "EXECUTION_PROVIDER": "modal" } }');
  assert.equal(run.status, 0);
});
