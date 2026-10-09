// Thin wrapper: parse argv, build the staging directory, spawn Wrangler,
// forward signals, map the exit. Boundary checks live in wrangler-safe-lib.mjs.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStagingDirectory,
  forwardSignals,
  mapChildExit,
  resolveWranglerCommand,
  UsageError,
} from "./wrangler-safe-lib.mjs";

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const wranglerBin = join(appDirectory, "node_modules", "wrangler", "bin", "wrangler.js");

let command;
try {
  command = resolveWranglerCommand(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}

// Wrangler/esbuild interprets glob metacharacters in an absolute entry path,
// and this repository is intentionally named `Cog*Portal`. Wrangler therefore
// runs against a metacharacter-free staging directory, never the real tree.
const staging = buildStagingDirectory({ appDirectory });

const args = command === "build"
  ? ["deploy", "--dry-run", "--outdir", "dist"]
  : [command];

const child = spawn(
  process.execPath,
  [wranglerBin, ...args, "--cwd", staging.path, "--config", "wrangler.jsonc"],
  {
    cwd: staging.path,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? join(staging.path, "wrangler.log"),
    },
    stdio: "inherit",
  },
);

const stopForwardingSignals = forwardSignals(child);

let finished = false;
function finish(exitCode) {
  if (finished) return;
  finished = true;
  stopForwardingSignals();
  staging.dispose();
  process.exit(exitCode);
}

child.on("error", (error) => {
  console.error(`Could not start Wrangler: ${error.message}`);
  finish(1);
});

child.on("exit", (code, signal) => {
  finish(mapChildExit({ code, signal }));
});
