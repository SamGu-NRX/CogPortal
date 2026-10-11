// Worker + SPA server orchestration. One origin serves both: the cloudflare
// vite plugin's dev server runs the Worker (source, workerd) and the SPA on a
// single port, with the fixture execution provider and dev-auth enabled via a
// generated .dev.vars. No repo file is edited; .dev.vars is gitignored.
// NOTE: `vite preview` is NOT usable here — the plugin merges .dev.vars into
// Worker bindings only in dev mode, so preview serves wrangler.jsonc's
// production vars (DEV_AUTH=disabled) and every dev-auth login 404s.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";

// Local-only test values. DEV_AUTH only activates with ENVIRONMENT=development,
// and real GitHub/Discord/Modal integrations stay off: any code path calling
// discord.com or GitHub OAuth must be unreachable in these runs.
export const DEV_VARS_TEMPLATE = {
  ENVIRONMENT: "development",
  DEV_AUTH: "enabled",
  BETTER_AUTH_SECRET: "upgrade-suite-local-secret",
  BETTER_AUTH_URL: "",
  RUNNER_SIGNING_SECRET: "upgrade-suite-local-runner-secret",
  EXECUTION_PROVIDER: "fixture",
};

export function writeDevVars(checkoutDir, overrides = {}) {
  const file = path.join(checkoutDir, "apps", "portal", ".dev.vars");
  const vars = { ...DEV_VARS_TEMPLATE, ...overrides };
  const lines = Object.entries(vars)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

export function buildPortal({ checkoutDir, nodeDir, logFile }) {
  const env = { ...process.env };
  if (nodeDir) env.PATH = `${nodeDir}:${env.PATH}`;
  const r = spawnSync("pnpm", ["--filter", "@cogworks/portal", "run", "build"], {
    cwd: checkoutDir,
    encoding: "utf8",
    env,
    timeout: 480_000,
  });
  if (logFile) appendFileSync(logFile, `--- build exit ${r.status} ---\n${(r.stdout || "") + (r.stderr || "")}`);
  if (r.status !== 0) {
    throw new Error(`portal build failed (exit ${r.status}):\n${((r.stderr || "") + (r.stdout || "")).slice(-4000)}`);
  }
  return true;
}

/**
 * Start the built Worker + SPA on one origin and wait for it to answer.
 * Returns { baseUrl, logPath, stop() }.
 */
export function startPortal({ checkoutDir, port = 5173, nodeDir }) {
  const logDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".cache");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `preview.${port}.log`);
  const portalDir = path.join(checkoutDir, "apps", "portal");
  const env = { ...process.env };
  if (nodeDir) env.PATH = `${nodeDir}:${env.PATH}`;

  // vite dev (not preview): dev mode is what merges .dev.vars into the
  // Worker bindings — dev-auth and the fixture provider live there.
  const child = spawn(
    "pnpm",
    ["exec", "vite", "--port", String(port), "--strictPort"],
    { cwd: portalDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log = (chunk) => appendFileSync(logPath, chunk);
  child.stdout?.on("data", log);
  child.stderr?.on("data", log);
  const stop = () => {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  };

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const deadline = started + 180_000;
    const poll = async () => {
      if (child.exitCode !== null) {
        reject(new Error(`vite preview exited (${child.exitCode}); log: ${logPath}`));
        return;
      }
      try {
        const res = await fetch(`http://localhost:${port}/`);
        if (res.ok) {
          resolve({ baseUrl: `http://localhost:${port}`, logPath, stop });
          return;
        }
      } catch { /* not up yet */ }
      if (Date.now() > deadline) {
        stop();
        reject(new Error(`vite dev server did not answer within 180s; log: ${logPath}`));
        return;
      }
      setTimeout(poll, 500);
    };
    poll();
  });
}

export function killPort(port) {
  spawnSync("fuser", ["-k", `${port}/tcp`], { stdio: "ignore" });
}
