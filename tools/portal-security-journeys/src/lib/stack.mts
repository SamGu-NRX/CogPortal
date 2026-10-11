/**
 * Fresh-stack boot for one journey: repo root discovery, wiped local D1
 * state, dev-only vars, a seeded catalog, and a local vite server (the
 * cloudflare vite plugin hosts the built worker + SPA assets). Every boot
 * gets its own port and its own wiped .wrangler state.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Stack } from "./framework.mts";
import { RUNNER_SECRET } from "./runner.mts";

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error("repo root (pnpm-workspace.yaml) not found — run from a CogPortal checkout");
}

export type BootStackOptions = { devAuth?: boolean; withGithubConfig?: boolean };

export async function bootStack(journeyId: string, log: (line: string) => void, opts: BootStackOptions = {}): Promise<Stack> {
  const root = repoRoot();
  const portal = join(root, "apps", "portal");
  if (!existsSync(join(portal, "package.json"))) throw new Error(`portal app not found at ${portal}`);
  const stateDir = mkdtempSync(join(tmpdir(), `cogportal-sec-${journeyId}-`));
  const port = 8900 + (Math.floor(Math.random() * 90) + 10);
  const vars = [
    "ENVIRONMENT=development",
    `DEV_AUTH=${opts.devAuth === false ? "disabled" : "enabled"}`,
    ...(opts.withGithubConfig
      ? ["GITHUB_CLIENT_ID=Iv23li0000000journey-placeholder", "GITHUB_CLIENT_SECRET=sec-journeys-placeholder-not-a-real-secret"]
      : []),
    `BETTER_AUTH_SECRET=sec-journeys-${journeyId}-${Date.now().toString(36)}`,
    `RUNNER_SIGNING_SECRET=${RUNNER_SECRET}`,
    "EXECUTION_PROVIDER=fixture",
    "",
  ].join("\n");
  writeFileSync(join(portal, ".dev.vars"), vars);

  // Fresh D1: wipe the default local state path, then let the cloudflare
  // vite plugin apply migrations on boot.
  rmSync(join(portal, ".wrangler", "state"), { recursive: true, force: true });

  log(`booting vite (portal) on :${port} with fresh D1 state`);
  const child: ChildProcess = spawn("pnpm", ["exec", "vite", "--port", String(port), "--strictPort"], {
    cwd: portal,
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite exited early (${child.exitCode}): ${out.slice(-400)}`);
    try {
      const res = await fetch(`${baseUrl}/api/benchmarks`);
      if (res.status === 200) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!up) throw new Error(`stack never became ready: ${out.slice(-400)}`);

  // Seed the local catalog (cohorts, benchmarks, fixture repo) if the repo
  // ships a seed file. If the plugin already applied it, a duplicate-seed
  // failure is non-fatal — journeys that need seeded rows will fail loudly
  // on missing data.
  const cfg = readFileSync(join(portal, "wrangler.jsonc"), "utf8");
  const dbName = /"database_name"\s*:\s*"([^"]+)"/.exec(cfg)?.[1];
  const seedCandidates = [join(portal, "seed-local.sql"), join(root, "scripts", "seed-local.sql"), join(root, "seed-local.sql")];
  const seed = seedCandidates.find((p) => existsSync(p));
  if (dbName && seed) {
    try {
      execSync(`pnpm exec wrangler d1 execute ${dbName} --local --file=${seed}`, { cwd: portal, stdio: "ignore" });
      log("seeded local D1");
    } catch (err) {
      log(`seed step failed (continuing; likely already applied): ${String(err).slice(0, 120)}`);
    }
  } else {
    log("no seed file or database_name found — continuing unseeded");
  }

  log(`stack ready at ${baseUrl}`);
  const stack: Stack = {
    baseUrl,
    port,
    root,
    log,
    teardown: async () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 3000);
      try {
        rmSync(stateDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
  return stack;
}
