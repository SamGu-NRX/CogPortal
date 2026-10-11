/**
 * Fresh-stack boot for one journey: repo root discovery, a per-journey local
 * D1 state directory, dev-only bindings, a seeded catalog, and a local vite
 * server (the cloudflare vite plugin hosts the built worker + SPA assets).
 * Every boot gets its own port and its own wrangler state; the checkout's
 * shared .dev.vars and .wrangler state are never read or written.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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

/** The subset of the portal's wrangler.jsonc the journey boot needs. */
type WranglerConfig = {
  main?: string;
  d1_databases?: Array<{
    binding: string;
    database_name: string;
    database_id: string;
    migrations_dir?: string;
  }>;
  vars?: Record<string, string>;
};

/**
 * Strip `//` line comments from a JSONC document. String literals are
 * tracked so `//` inside URLs survives; the portal config only uses line
 * comments, never block comments.
 */
function stripJsoncLineComments(source: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < source.length) {
        out += source[i + 1];
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i + 1 < source.length && source[i + 1] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Parse the portal's wrangler.jsonc and re-emit it as plain JSON with the
 * worker entry and D1 migration paths made absolute (the journey's copy of
 * the config lives in the boot's temp directory, so relative paths would
 * otherwise resolve against the temp dir instead of the portal app).
 */
function journeyWranglerConfig(portal: string, devVars: Record<string, string>): WranglerConfig {
  const source = readFileSync(join(portal, "wrangler.jsonc"), "utf8");
  const base = JSON.parse(stripJsoncLineComments(source)) as WranglerConfig;
  if (!base.main) throw new Error("portal wrangler.jsonc has no main worker entry");
  if (!base.d1_databases?.length) throw new Error("portal wrangler.jsonc has no d1_databases binding");
  return {
    ...base,
    main: join(portal, base.main),
    d1_databases: base.d1_databases.map((db) => ({
      ...db,
      migrations_dir: join(portal, db.migrations_dir ?? "migrations"),
    })),
    vars: { ...base.vars, ...devVars },
  };
}

export async function bootStack(journeyId: string, log: (line: string) => void, opts: BootStackOptions = {}): Promise<Stack> {
  const root = repoRoot();
  const portal = join(root, "apps", "portal");
  if (!existsSync(join(portal, "package.json"))) throw new Error(`portal app not found at ${portal}`);

  // Everything this boot touches lives under its own temp directory: the D1
  // sqlite state, the generated wrangler config, and the generated vite
  // config. The checkout's shared .dev.vars and .wrangler state are never
  // read or written, and concurrent journeys cannot see each other's state.
  const stateDir = mkdtempSync(join(tmpdir(), `cogportal-sec-${journeyId}-`));
  const persistDir = join(stateDir, "d1");
  const port = 8900 + (Math.floor(Math.random() * 90) + 10);

  const devVars: Record<string, string> = {
    ENVIRONMENT: "development",
    DEV_AUTH: opts.devAuth === false ? "disabled" : "enabled",
    ...(opts.withGithubConfig
      ? {
          GITHUB_CLIENT_ID: "Iv23li0000000journey-placeholder",
          GITHUB_CLIENT_SECRET: "sec-journeys-placeholder-not-a-real-secret",
        }
      : {}),
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    RUNNER_SIGNING_SECRET: RUNNER_SECRET,
    EXECUTION_PROVIDER: "fixture",
  };

  // The wrangler config carries the journey's bindings: the checkout's real
  // config with absolute paths and the dev vars merged on top.
  const journeyConfig = journeyWranglerConfig(portal, devVars);
  const journeyConfigPath = join(stateDir, "wrangler.json");
  writeFileSync(journeyConfigPath, JSON.stringify(journeyConfig));

  // The vite config mirrors the portal's own config (same plugins, same
  // alias) but points the cloudflare plugin at this journey's wrangler
  // config and D1 state directory. Plugins resolve through the portal's
  // own node_modules, so the checkout's dependency layout is irrelevant.
  const journeyViteConfigPath = join(stateDir, "vite.config.mjs");
  writeFileSync(
    journeyViteConfigPath,
    [
      'import { createRequire } from "node:module";',
      `const requireFromPortal = createRequire(${JSON.stringify(join(portal, "package.json"))});`,
      `const load = async (id) => {`,
      `  const mod = await import(requireFromPortal.resolve(id));`,
      `  return mod.default ?? mod;`,
      `};`,
      `const react = await load("@vitejs/plugin-react");`,
      `const tailwind = await load("@tailwindcss/vite");`,
      `const cloudflareModule = await load("@cloudflare/vite-plugin");`,
      `const cloudflare = cloudflareModule.cloudflare ?? cloudflareModule.default;`,
      `export default async () => ({`,
      `  plugins: [`,
      `    react(),`,
      `    tailwind(),`,
      `    cloudflare({`,
      `      persistState: { path: ${JSON.stringify(persistDir)} },`,
      `      configPath: ${JSON.stringify(journeyConfigPath)},`,
      `    }),`,
      `  ],`,
      `  resolve: { alias: { "@": ${JSON.stringify(join(portal, "src"))} } },`,
      `});`,
    ].join("\n"),
  );

  log(`booting vite (portal) on :${port} with per-journey D1 state`);
  const child: ChildProcess = spawn("pnpm", ["exec", "vite", "--config", journeyViteConfigPath, "--port", String(port), "--strictPort"], {
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
  // ships a seed file — executed against this journey's own state directory.
  const dbName = journeyConfig.d1_databases?.[0]?.database_name;
  const seedCandidates = [join(portal, "seed-local.sql"), join(root, "scripts", "seed-local.sql"), join(root, "seed-local.sql")];
  const seed = seedCandidates.find((p) => existsSync(p));
  if (dbName && seed) {
    try {
      execSync(`pnpm exec wrangler d1 execute ${dbName} --local --persist-to "${persistDir}" --config "${journeyConfigPath}" --file="${seed}"`, { cwd: portal, stdio: "ignore" });
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
