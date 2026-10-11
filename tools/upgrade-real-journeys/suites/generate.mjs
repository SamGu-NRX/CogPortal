// STAGE 1 — beta state generation. Fill in (owner: state-generation sub-thread).
// Objective: a fresh local D1 with beta's migrations + seed, then realistic
// course state created ONLY through beta's real paths (its own SPA and API as
// dev-auth users, and the 064400e CLI): cohorts, teams, joins and leaves,
// forks, device links, synced local reports from real public week data, hosted
// runs through the fixture provider, published official attempts, staff and TA
// assignments. Snapshot with lib/d1.mjs snapshot() under state/beta-snapshot/.
// Pass bar: `node bin/upgrade-suite.mjs generate` from a fresh clone produces
// the snapshot and a receipt (receipts/generate.json) listing every entity
// class with counts; no real student handles or submissions anywhere.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureNode24 } from "../lib/node24.mjs";
import { ensurePnpm } from "../lib/pnpm.mjs";
import { ensureBetaWorktree } from "../lib/beta-worktree.mjs";
import { applyMigrations, findD1File, persistDirFor, snapshot } from "../lib/d1.mjs";
import { writeDevVars, buildPortal, startPortal, killPort } from "../lib/servers.mjs";
import {
  BETA_COMMIT,
  CLI_PIN,
  ROSTER,
  assertGenerated,
  countEntities,
  ensureBetaDeps,
  generateBetaState,
  seedLocal,
} from "../lib/state-gen.mjs";

const SUITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = path.resolve(SUITE_DIR, "..", "..");
const PORT = 5173;

export async function run() {
  const t0 = Date.now();
  const log = (msg) => console.log(`[generate] ${msg}`);
  const logFile = path.join(SUITE_DIR, ".cache", "generate.log");
  mkdirSync(path.dirname(logFile), { recursive: true });
  const receiptPath = path.join(SUITE_DIR, "receipts", "generate.json");
  rmSync(receiptPath, { force: true });

  // Runtime + package manager, then the beta checkout and its deps.
  const { nodeDir } = await ensureNode24();
  await ensurePnpm({ nodeDir, cacheDir: path.join(SUITE_DIR, ".cache") });
  const { checkoutDir } = await ensureBetaWorktree({ repoDir: REPO_DIR, suiteDir: SUITE_DIR });
  ensureBetaDeps({ checkoutDir, nodeDir });

  // Fresh local D1: beta's migrations, then the repo seed (teams/runs only -
  // users come from beta's real login and join paths below).
  const persistDir = persistDirFor(checkoutDir);
  rmSync(persistDir, { recursive: true, force: true });
  applyMigrations({ checkoutDir, nodeDir });
  seedLocal({ checkoutDir, nodeDir });
  const baseline = countEntities(findD1File(persistDir));
  log(`seeded baseline: ${JSON.stringify(baseline)}`);

  // Dev-auth on one origin; PLATFORM_OWNER_LOGINS bootstraps the owner login.
  writeDevVars(checkoutDir, { PLATFORM_OWNER_LOGINS: ROSTER.owner });
  buildPortal({ checkoutDir, nodeDir, logFile });
  killPort(PORT);
  const server = await startPortal({ checkoutDir, port: PORT, nodeDir });
  log(`server up at ${server.baseUrl}`);

  let state;
  try {
    state = await generateBetaState({
      checkoutDir,
      baseUrl: server.baseUrl,
      repoDir: REPO_DIR,
      suiteDir: SUITE_DIR,
      log,
    });
  } finally {
    server.stop();
    // Give miniflare a moment to flush sqlite before the snapshot.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const dbFile = findD1File(persistDir);
  const counts = countEntities(dbFile);
  const generated = Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [key, value - (baseline[key] ?? 0)]),
  );
  assertGenerated(generated);

  const snapshotDir = path.join(SUITE_DIR, "state", "beta-snapshot");
  snapshot(persistDir, snapshotDir);
  if (!existsSync(dbFile.replace(persistDir, snapshotDir))) {
    throw new Error("snapshot did not preserve the D1 sqlite file");
  }

  const receipt = {
    stage: "generate",
    generatedAt: new Date().toISOString(),
    beta: { commit: BETA_COMMIT, checkout: "suite .cache/beta-worktree (git worktree, deps installed)" },
    cli: {
      pin: CLI_PIN,
      package: "python/cogbench",
      install: `pip install from a local git worktree at ${CLI_PIN} (commit present in this repo's history; no network install)`,
      week: state.cliWeek,
    },
    executionProvider: "fixture",
    method:
      "All state created through beta's real paths: POST /api/dev/login with generated upg-* handles only; " +
      "/api/cohorts/join (code VISION26); /api/github/connect with the fixture repo (creates the one fork-provenance team); " +
      "/api/team/join and DELETE /api/team/members/:login for joins/leaves; /api/admin/staff and /api/admin/teams/:id/tas " +
      "for staff and TA assignments (owner PLATFORM_OWNER_LOGINS in .dev.vars); /api/runs/practice, /api/runs/:id and " +
      "/api/runs/:id/promote for hosted fixture runs and published official attempts; the pinned 064400e CLI linked via " +
      "/v1/cli/device/* and produced local reports with cogworks run --live, cogworks run + cogworks sync against real " +
      "public week data (benchmarks/week* submodule). No real student handles or submissions anywhere; no discord.com, " +
      "no real GitHub OAuth, no Modal, no dev/prod Workers/D1/R2.",
    counts,
    generated,
    accounts: {
      owner: [ROSTER.owner],
      staff: ROSTER.staff,
      tas: ROSTER.tas,
      students: ROSTER.students,
      note: "generated test accounts only (login@dev.local, dev-auth)",
    },
    quirks: state.quirks,
    timings: { ...state.timings, totalMs: Date.now() - t0 },
  };
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  log(`receipt: ${JSON.stringify(counts)}`);
  log(`stage generate finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { counts, generated, snapshotDir };
}

process.argv[1]?.endsWith("generate.mjs") && run().catch((e) => { console.error(e); process.exit(1); });
