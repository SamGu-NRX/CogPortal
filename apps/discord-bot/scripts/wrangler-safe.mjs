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
