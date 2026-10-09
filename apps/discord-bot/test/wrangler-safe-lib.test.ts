import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStagingDirectory,
  forwardSignals,
  mapChildExit,
  resolveWranglerCommand,
  UsageError,
  WRANGLER_COMMANDS,
} from "../scripts/wrangler-safe-lib.mjs";

const USAGE_LINE = "Usage: node scripts/wrangler-safe.mjs <build|deploy|dev>";

// Real temp root per test, named after the test so leftovers are identifiable.
function tempRootFor(name: string): string {
  const safe = name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return mkdtempSync(join(tmpdir(), `wrangler-safe-lib-${safe}-`));
}

interface AppOptions {
  devVars?: boolean;
  env?: boolean;
  envLocal?: boolean;
}

function makeAppDirectory(root: string, options: AppOptions = {}): string {
  const appDirectory = join(root, "app");
  mkdirSync(join(appDirectory, "src"), { recursive: true });
  writeFileSync(join(appDirectory, "wrangler.jsonc"), '{ "name": "cogbot-test" }\n');
  writeFileSync(join(appDirectory, "src", "index.ts"), "export {};\n");
  if (options.devVars) writeFileSync(join(appDirectory, ".dev.vars"), "SECRET=1\n");
  if (options.env) writeFileSync(join(appDirectory, ".env"), "ENV=1\n");
  if (options.envLocal) writeFileSync(join(appDirectory, ".env.local"), "ENV_LOCAL=1\n");
  return appDirectory;
}

function cleanupRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

class FakeChild {
  readonly killed: string[] = [];

  kill(signal?: string | number): boolean {
    this.killed.push(String(signal));
    return true;
  }
}

test("WRANGLER_COMMANDS holds exactly the three supported commands", () => {
  assert.deepEqual(WRANGLER_COMMANDS, ["build", "deploy", "dev"]);
});

test("resolveWranglerCommand returns the command when argv holds exactly one", () => {
  for (const command of WRANGLER_COMMANDS) {
    assert.equal(resolveWranglerCommand([command]), command);
  }
});

test("resolveWranglerCommand rejects an empty argv with the usage line", () => {
  assert.throws(() => resolveWranglerCommand([]), (error: unknown) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /missing wrangler command/);
    assert.ok(error.message.endsWith(USAGE_LINE));
    return true;
  });
});

test("resolveWranglerCommand names an unknown command in the message", () => {
  assert.throws(() => resolveWranglerCommand(["start"]), (error: unknown) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /unknown wrangler command: start/);
    assert.ok(error.message.endsWith(USAGE_LINE));
    return true;
  });
});

test("resolveWranglerCommand rejects extra arguments such as flags", () => {
  assert.throws(() => resolveWranglerCommand(["dev", "--port", "9999"]), (error: unknown) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /unexpected extra arguments: --port 9999/);
    assert.ok(error.message.endsWith(USAGE_LINE));
    return true;
  });
});

test("buildStagingDirectory copies wrangler.jsonc and symlinks src and env files", () => {
  const root = tempRootFor("staging-happy");
  try {
    const appDirectory = makeAppDirectory(root, { devVars: true, env: true, envLocal: true });
    const staging = buildStagingDirectory({ appDirectory, tempRoot: root });
    try {
      const configFile = join(staging.path, "wrangler.jsonc");
      assert.ok(!lstatSync(configFile).isSymbolicLink(), "wrangler.jsonc must be a copy");
      assert.equal(
        readFileSync(configFile, "utf8"),
        readFileSync(join(appDirectory, "wrangler.jsonc"), "utf8"),
      );

      const srcLink = join(staging.path, "src");
      assert.ok(lstatSync(srcLink).isSymbolicLink());
      assert.equal(readlinkSync(srcLink), join(appDirectory, "src"));
      assert.ok(existsSync(join(srcLink, "index.ts")), "src symlink must resolve into the live tree");

      for (const filename of [".dev.vars", ".env", ".env.local"]) {
        const link = join(staging.path, filename);
        assert.ok(lstatSync(link).isSymbolicLink(), `${filename} must be symlinked when present`);
        assert.equal(readlinkSync(link), join(appDirectory, filename));
      }
    } finally {
      staging.dispose();
    }
  } finally {
    cleanupRoot(root);
  }
});

test("buildStagingDirectory omits symlinks for env files that do not exist", () => {
  const root = tempRootFor("staging-no-env-files");
  try {
    const appDirectory = makeAppDirectory(root);
    const staging = buildStagingDirectory({ appDirectory, tempRoot: root });
    try {
      assert.ok(lstatSync(join(staging.path, "src")).isSymbolicLink());
      for (const filename of [".dev.vars", ".env", ".env.local"]) {
        assert.equal(
          existsSync(join(staging.path, filename)),
          false,
          `${filename} must be absent when the app has none`,
        );
      }
    } finally {
      staging.dispose();
    }
  } finally {
    cleanupRoot(root);
  }
});

test("buildStagingDirectory defaults the temp root to os.tmpdir()", () => {
  const root = tempRootFor("staging-default-temp-root");
  try {
    const appDirectory = makeAppDirectory(root);
    const staging = buildStagingDirectory({ appDirectory });
    try {
      assert.ok(staging.path.startsWith(tmpdir()));
    } finally {
      staging.dispose();
    }
  } finally {
    cleanupRoot(root);
  }
});

test("buildStagingDirectory rejects a missing wrangler.jsonc with a specific message", () => {
  const root = tempRootFor("staging-missing-config");
  try {
    const appDirectory = join(root, "config-only");
    mkdirSync(appDirectory, { recursive: true });
    assert.throws(
      () => buildStagingDirectory({ appDirectory, tempRoot: root }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          `wrangler.jsonc not found in ${appDirectory}; run this script from the app directory that owns it.`,
        );
        return true;
      },
    );
  } finally {
    cleanupRoot(root);
  }
});

test("buildStagingDirectory rejects a missing src directory with a specific message", () => {
  const root = tempRootFor("staging-missing-src");
  try {
    const appDirectory = join(root, "config-only");
    mkdirSync(appDirectory, { recursive: true });
    writeFileSync(join(appDirectory, "wrangler.jsonc"), "{}\n");
    assert.throws(
      () => buildStagingDirectory({ appDirectory, tempRoot: root }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          `src not found in ${appDirectory}; run this script from the app directory that owns it.`,
        );
        return true;
      },
    );
  } finally {
    cleanupRoot(root);
  }
});

test("dispose removes the staging directory and is safe to call twice", () => {
  const root = tempRootFor("dispose-twice");
  try {
    const appDirectory = makeAppDirectory(root);
    const staging = buildStagingDirectory({ appDirectory, tempRoot: root });
    assert.ok(existsSync(staging.path));
    staging.dispose();
    assert.equal(existsSync(staging.path), false);
    staging.dispose();
  } finally {
    cleanupRoot(root);
  }
});

test("mapChildExit maps signals and codes to shell-style exit statuses", () => {
  assert.equal(mapChildExit({ code: null, signal: "SIGINT" }), 130);
  assert.equal(mapChildExit({ code: null, signal: "SIGTERM" }), 143);
  assert.equal(mapChildExit({ code: null, signal: "SIGQUIT" }), 1);
  assert.equal(mapChildExit({ code: 0, signal: null }), 0);
  assert.equal(mapChildExit({ code: 3, signal: null }), 3);
  assert.equal(mapChildExit({ code: undefined, signal: null }), 1);
});

test("forwardSignals forwards each signal to the child and unsubscribe stops it", () => {
  const child = new FakeChild();
  // SIGHUP and SIGWINCH instead of SIGUSR2: the test runner's child runs with
  // --report-signal=SIGUSR2, so emitting that signal would drop a diagnostic
  // report file into the working directory.
  const stop = forwardSignals(child, ["SIGHUP", "SIGWINCH"]);

  assert.ok(process.emit("SIGHUP"), "listener must be attached for SIGHUP");
  assert.ok(process.emit("SIGWINCH"), "listener must be attached for SIGWINCH");
  assert.deepEqual(child.killed, ["SIGHUP", "SIGWINCH"]);

  stop();
  assert.equal(process.emit("SIGHUP"), false, "unsubscribe must remove the listeners");
  assert.deepEqual(child.killed, ["SIGHUP", "SIGWINCH"]);
});

test("forwardSignals defaults to SIGINT and SIGTERM", () => {
  const child = new FakeChild();
  const before = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
  };
  const stop = forwardSignals(child);
  try {
    assert.equal(process.listenerCount("SIGINT"), before.sigint + 1);
    assert.equal(process.listenerCount("SIGTERM"), before.sigterm + 1);
  } finally {
    stop();
  }
  assert.equal(process.listenerCount("SIGINT"), before.sigint);
  assert.equal(process.listenerCount("SIGTERM"), before.sigterm);
});
