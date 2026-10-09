// Runnable example: how scripts/register-commands.mjs behaves when started
// without Discord credentials. It must fail fast with a clear message instead
// of reaching for the network. Runs with no credentials and no network:
//
//   node scripts/examples/register-guard.example.mjs
//
// The example strips DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, and
// COURSE_GUILD_ID from the child env, then expects a nonzero exit carrying the
// fail-fast message. A timeout plus SIGKILL guarantees the child can never
// hang the caller.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 10_000;
const FAIL_FAST_MESSAGE = "Set DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, and COURSE_GUILD_ID.";
const registerScript = join(dirname(fileURLToPath(import.meta.url)), "..", "register-commands.mjs");

const env = { ...process.env };
delete env.DISCORD_APPLICATION_ID;
delete env.DISCORD_BOT_TOKEN;
delete env.COURSE_GUILD_ID;

const child = spawn(process.execPath, [registerScript], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const killTimer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);

const [code, signal] = await new Promise((resolve) => {
  child.on("close", (code, signal) => resolve([code, signal]));
});
clearTimeout(killTimer);

try {
  assert.notEqual(code, 0, "register-commands.mjs should exit nonzero without credentials");
  assert.equal(signal, null, "register-commands.mjs should fail fast on its own, not be killed");
  assert.ok(
    stderr.includes(FAIL_FAST_MESSAGE),
    `stderr should surface the fail-fast message, got: ${stderr.trim()}`,
  );
} catch (error) {
  console.error(`register-guard.example: mismatch: ${error.message}`);
  process.exit(1);
}

const surfaced = stderr
  .split("\n")
  .map((line) => line.trim())
  .find((line) => line.startsWith("Error: ") && line.includes(FAIL_FAST_MESSAGE));

console.log("register-commands.mjs refuses to run without credentials:");
console.log(`  ${(surfaced ?? FAIL_FAST_MESSAGE).replace(/^Error:\s*/, "")}`);
