// Pure helpers for wrangler-safe.mjs: argument parsing, staging-directory
// setup, child exit mapping, and signal forwarding. Kept free of process
// state (except the explicit signal wiring in forwardSignals) so every branch
// can be tested without spawning Wrangler.

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Thrown for command-line misuse; the message is what the user sees. */
export class UsageError extends Error {}

export const WRANGLER_COMMANDS = ["build", "deploy", "dev"];

const USAGE_LINE = "Usage: node scripts/wrangler-safe.mjs <build|deploy|dev>";

// The wrapper forwards no extra flags on purpose: it picks Wrangler's flags
// itself, so anything typed after the command name would be silently dropped.
// Reject it instead.
export function resolveWranglerCommand(argv) {
  const [command, ...extra] = argv;
  if (command === undefined) {
    throw new UsageError(
      `missing wrangler command; expected one of ${WRANGLER_COMMANDS.join(", ")}\n${USAGE_LINE}`,
    );
  }
  if (!WRANGLER_COMMANDS.includes(command)) {
    throw new UsageError(
      `unknown wrangler command: ${command}; expected one of ${WRANGLER_COMMANDS.join(", ")}\n${USAGE_LINE}`,
    );
  }
  if (extra.length > 0) {
    throw new UsageError(
      `unexpected extra arguments: ${extra.join(" ")}. This wrapper forwards no extra flags; ` +
        `edit scripts/wrangler-safe.mjs if you need one.\n${USAGE_LINE}`,
    );
  }
  return command;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Wrangler/esbuild interprets glob metacharacters in an absolute entry path.
// The repository is intentionally named `Cog*Portal`, so Wrangler must never
// run against the real tree. It gets a metacharacter-free staging directory
// that holds a copy of wrangler.jsonc, a `src` symlink into the live tree,
// and symlinks to each env file the app provides. Source stays single-copy
// and dev mode still observes edits through the symlink.
export function buildStagingDirectory({ appDirectory, tempRoot } = {}) {
  const wranglerConfig = join(appDirectory, "wrangler.jsonc");
  if (!existsSync(wranglerConfig)) {
    throw new Error(
      `wrangler.jsonc not found in ${appDirectory}; run this script from the app directory that owns it.`,
    );
  }
  const sourceDirectory = join(appDirectory, "src");
  if (!isDirectory(sourceDirectory)) {
    throw new Error(
      `src not found in ${appDirectory}; run this script from the app directory that owns it.`,
    );
  }

  const stagingDirectory = mkdtempSync(join(tempRoot ?? tmpdir(), "cogbot-wrangler-"));
  copyFileSync(wranglerConfig, join(stagingDirectory, "wrangler.jsonc"));
  symlinkSync(sourceDirectory, join(stagingDirectory, "src"), "dir");

  for (const filename of [".dev.vars", ".env", ".env.local"]) {
    const source = join(appDirectory, filename);
    if (existsSync(source)) symlinkSync(source, join(stagingDirectory, filename), "file");
  }

  let disposed = false;
  return {
    path: stagingDirectory,
    dispose() {
      if (disposed) return;
      disposed = true;
      rmSync(stagingDirectory, { recursive: true, force: true });
    },
  };
}

// A Wrangler run killed by a signal must surface as the conventional shell
// status; a child that exits without a code maps to 1 rather than 0.
export function mapChildExit({ code, signal } = {}) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (signal) return 1;
  return code ?? 1;
}

// Handlers must exist before the child can start producing output or exit.
// Attaching after spawn leaves a window where SIGINT kills the wrapper and
// leaks the staging directory. Returns the unsubscribe used by finish().
export function forwardSignals(child, signals = ["SIGINT", "SIGTERM"]) {
  const unsubscribers = signals.map((signal) => {
    const forward = () => child.kill(signal);
    process.on(signal, forward);
    return () => process.off(signal, forward);
  });
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
