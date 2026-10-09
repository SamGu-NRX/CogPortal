// Runnable example: how scripts/wrangler-safe.mjs guards its command argument.
// An unknown subcommand prints a Usage line and exits with code 2 before any
// Wrangler work (staging dir, bundling) happens. Runs with no credentials and
// no network:
//
//   node scripts/examples/wrangler-safe-usage.example.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 10_000;
const wranglerSafeScript = join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler-safe.mjs");

const child = spawn(process.execPath, [wranglerSafeScript, "deploy-prod"], {
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

const usageLine = stderr
  .split("\n")
  .map((line) => line.trim())
  .find((line) => line.startsWith("Usage:"));

try {
  assert.equal(
    code,
    2,
    `unknown commands should exit with code 2, got ${code} (${signal === null ? "no signal" : signal})`,
  );
  assert.equal(signal, null, "wrangler-safe.mjs should reject the argument on its own, not be killed");
  assert.ok(usageLine, `stderr should contain the Usage line, got: ${stderr.trim()}`);
} catch (error) {
  console.error(`wrangler-safe-usage.example: mismatch: ${error.message}`);
  process.exit(1);
}

console.log("wrangler-safe.mjs rejects unknown commands with exit code 2:");
console.log(`  ${usageLine}`);
