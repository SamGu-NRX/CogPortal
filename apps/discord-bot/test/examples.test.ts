import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The scripts/examples/*.mjs files are documentation that has to keep working,
// so this suite runs each one the way an operator would — as a fresh `node`
// process from the app directory — and asserts a clean exit plus the evidence
// each example prints on success.
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function runExample(script: string) {
  return spawnSync(process.execPath, [join("scripts", "examples", script)], {
    cwd: appDir,
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("payloads.example.mjs proves both command payloads keep their contract", () => {
  const run = runExample("payloads.example.mjs");

  assert.equal(run.status, 0);
  assert.equal(run.signal, null);
  assert.match(run.stdout, /type 1/);
  assert.match(run.stdout, /home, leaderboard, benchmarks, local, connect/);
  assert.match(run.stdout, /type 4/);
});

test("register-guard.example.mjs proves register-commands.mjs fails fast without credentials", () => {
  const run = runExample("register-guard.example.mjs");

  assert.equal(run.status, 0);
  assert.equal(run.signal, null);
  assert.match(run.stdout, /Set DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, and COURSE_GUILD_ID/);
});

test("wrangler-safe-usage.example.mjs proves unknown commands exit 2 with a Usage line", () => {
  const run = runExample("wrangler-safe-usage.example.mjs");

  assert.equal(run.status, 0);
  assert.equal(run.signal, null);
  assert.match(run.stdout, /Usage: node scripts\/wrangler-safe\.mjs <build\|deploy\|dev>/);
});
