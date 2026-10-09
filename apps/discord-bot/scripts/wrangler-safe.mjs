// Runs Wrangler for this app from a checkout whose path contains a glob
// metacharacter. The repository is named Cog*Portal, and Wrangler builds with
// esbuild, which treats a * in an entry path as a glob pattern, so running
// Wrangler directly from such a checkout breaks. The wrapper exposes the live
// source tree through a temporary staging directory with a metacharacter-free
// path: wrangler.jsonc is copied in, src/ is symlinked so dev mode still
// observes edits, and .dev.vars, .env, or .env.local are symlinked when
// present. The staging directory is deleted on exit.
//
// build runs `wrangler deploy --dry-run --outdir dist` as a bundling smoke
// test; its dist output lands in the staging directory and is discarded on
// exit. deploy and dev pass through unchanged.
//
// The child receives the full environment, with WRANGLER_LOG_PATH defaulted to
// a log file inside the staging directory. SIGINT and SIGTERM are forwarded to
// the child, and the script exits 130 or 143 when killed by a signal,
// otherwise with the child's exit code. Staging cleanup is guarded so it runs
// exactly once.
//
// Usage: pnpm --filter @cogworks/discord-bot dev|build|deploy, or
// node scripts/wrangler-safe.mjs <build|deploy|dev>.
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const wranglerBin = join(appDirectory, "node_modules", "wrangler", "bin", "wrangler.js");
const command = process.argv[2];

if (!new Set(["build", "deploy", "dev"]).has(command)) {
  console.error("Usage: node scripts/wrangler-safe.mjs <build|deploy|dev>");
  process.exit(2);
}

// Wrangler/esbuild interprets glob metacharacters in an absolute entry path. This
// repository is intentionally named `Cog*Portal`, so expose the live source tree
// through a temporary path with no metacharacters. Source remains single-copy and
// dev mode still observes edits through the symlink.
const stagingDirectory = mkdtempSync(join(tmpdir(), "cogbot-wrangler-"));
copyFileSync(join(appDirectory, "wrangler.jsonc"), join(stagingDirectory, "wrangler.jsonc"));
symlinkSync(join(appDirectory, "src"), join(stagingDirectory, "src"), "dir");

for (const filename of [".dev.vars", ".env", ".env.local"]) {
  const source = join(appDirectory, filename);
  if (existsSync(source)) symlinkSync(source, join(stagingDirectory, filename), "file");
}

const args = command === "build"
  ? ["deploy", "--dry-run", "--outdir", "dist"]
  : [command];

const child = spawn(
  process.execPath,
  [wranglerBin, ...args, "--cwd", stagingDirectory, "--config", "wrangler.jsonc"],
  {
    cwd: stagingDirectory,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? join(stagingDirectory, "wrangler.log"),
    },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

let finished = false;
function finish(exitCode) {
  if (finished) return;
  finished = true;
  rmSync(stagingDirectory, { recursive: true, force: true });
  process.exit(exitCode);
}

child.on("error", (error) => {
  console.error(`Could not start Wrangler: ${error.message}`);
  finish(1);
});

child.on("exit", (code, signal) => {
  const signalCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
  finish(signal ? signalCode : (code ?? 1));
});
