import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";

// Resolve a temporary source config, not a stale Vite deployment redirect.
// Nothing here builds, deploys, or edits the real configuration.
const portalDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(portalDirectory, "wrangler.jsonc");
const patchPath = join(dirname(dirname(portalDirectory)), "docs/runbooks/production-closure.patch");

function copy(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "cog-closure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, "apps/portal/wrangler.jsonc");
  mkdirSync(dirname(config), { recursive: true });
  copyFileSync(configPath, config);
  return { directory, config };
}

function patch(directory: string, reverse = false) {
  execFileSync("git", ["apply", ...(reverse ? ["--reverse"] : []), patchPath], {
    cwd: directory,
    stdio: "pipe",
  });
}

function withoutClosure(config: ReturnType<typeof unstable_readConfig>) {
  const { workers_dev: _workersDev, preview_urls: _previews, triggers, ...rest } = config;
  const { crons: _crons, ...otherTriggers } = triggers;
  return { ...rest, triggers: otherTriggers };
}

test("production resolves closed with all nonclosure settings preserved", (t) => {
  const { directory, config } = copy(t);
  const before = unstable_readConfig({ config, env: "production" });
  assert.equal(before.workers_dev, true);
  assert.deepEqual(before.triggers.crons, ["*/5 * * * *"]);

  patch(directory);
  const after = unstable_readConfig({ config, env: "production" });
  assert.equal(after.name, "cogportal-production");
  assert.equal(after.workers_dev, false);
  assert.equal(after.preview_urls, false);
  assert.deepEqual(after.triggers.crons, []);
  // Deep comparison retains nested binding/variable fields, not just key names.
  assert.deepEqual(withoutClosure(after), withoutClosure(before));
});

test("the patch preserves the entire resolved development configuration", (t) => {
  const { directory, config } = copy(t);
  const before = unstable_readConfig({ config });
  patch(directory);
  assert.deepEqual(unstable_readConfig({ config }), before);
});

test("reverse application restores exact bytes without modifying the source", (t) => {
  const original = readFileSync(configPath);
  const { directory, config } = copy(t);
  patch(directory);
  assert.notDeepEqual(readFileSync(config), original);
  patch(directory, true);
  assert.deepEqual(readFileSync(config), original);
  assert.deepEqual(readFileSync(configPath), original);
});
