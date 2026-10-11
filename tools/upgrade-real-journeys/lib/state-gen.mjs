// Beta state generation through beta's real paths (stage 1). No row is
// written directly: every entity comes from beta's own API as dev-auth users
// with generated upg-* handles, or from the pinned student CLI (064400e) doing
// its real device-link / local-report flow. The database is only read
// (countEntities) for the receipt. Fixture execution provider only; no
// discord.com, no real GitHub OAuth, no Modal, no dev/prod surfaces.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { openD1, persistDirFor } from "./d1.mjs";

export const BETA_COMMIT = "17d26d9";
export const CLI_PIN = "064400e";
export const FIXTURE_REPO_FULL = "cogworks-demo/face-finder";
export const COHORT_JOIN_CODE = "VISION26";

/** Every handle the stage creates - generated suite accounts, never real. */
export const ROSTER = {
  owner: "upg-staff-01",
  staff: ["upg-staff-02", "upg-staff-03"],
  tas: ["upg-ta-01", "upg-ta-02"],
  students: [
    "upg-stu-01", "upg-stu-02", "upg-stu-03", "upg-stu-04",
    "upg-stu-05", "upg-stu-06", "upg-stu-07", "upg-stu-08",
  ],
};

/** Minimum generated (delta) counts for the stage to call itself done. */
export const REQUIRED_MIN = {
  users: 13, students: 8, staff: 2, tas: 2, teams: 1, memberships: 7, forks: 1,
  deviceLinks: 3, localReports: 2, localRunSessions: 1,
  hostedRuns: 5, hostedRunsSucceeded: 4, officialRuns: 4, officialAttempts: 4,
};

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── HTTP client with a per-user cookie jar ───────────────────────────────
export function makeClient(baseUrl) {
  const cookies = new Map();
  return async function api(pathName, { method = "GET", body, timeoutMs = 30_000 } = {}) {
    const headers = {};
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(baseUrl + pathName, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body: surfaced through the error path below on failure.
    }
    if (!res.ok) {
      const code = data?.error ?? data?.code ?? res.status;
      throw new Error(
        `API ${method} ${pathName} -> ${res.status} ${code}: ${String(data?.message ?? text).slice(0, 240)}`,
      );
    }
    return data;
  };
}

async function devLogin(api, login, demo = false) {
  // Dev-auth handles are server-side passwords; the request is {login, demo}.
  return api("/api/dev/login", { method: "POST", body: { login, demo } });
}

/** Spawn + wait helper for the CLI with a hard timeout. */
function runChecked(cmd, args, { cwd, env, timeoutMs }) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0 || r.error) {
    const why = r.error ? String(r.error) : `exit ${r.status}`;
    throw new Error(`${cmd} ${args.join(" ")} failed (${why}):\n${((r.stderr || "") + (r.stdout || "")).slice(-2400)}`);
  }
  return (r.stdout || "") + (r.stderr || "");
}

// ── Receipt counting (read-only) ─────────────────────────────────────────
export function countEntities(dbFile) {
  const db = openD1(dbFile);
  const one = (sql) => Number(db.prepare(sql).get()?.n ?? 0);
  const counts = {
    users: one("SELECT COUNT(*) AS n FROM users"),
    students: one("SELECT COUNT(*) AS n FROM users WHERE cohort_id IS NOT NULL"),
    staff: one("SELECT COUNT(*) AS n FROM platform_staff"),
    tas: one("SELECT COUNT(*) AS n FROM team_tas"),
    cohorts: one("SELECT COUNT(*) AS n FROM cohorts"),
    teams: one("SELECT COUNT(*) AS n FROM teams"),
    memberships: one("SELECT COUNT(*) AS n FROM team_members"),
    forks: one("SELECT COUNT(*) AS n FROM teams WHERE template_source_repo_id IS NOT NULL"),
    deviceLinks: one("SELECT COUNT(*) AS n FROM cli_devices"),
    deviceAuthorizations: one("SELECT COUNT(*) AS n FROM device_authorizations WHERE approved_at IS NOT NULL"),
    localReports: one("SELECT COUNT(*) AS n FROM local_reports"),
    localRunSessions: one("SELECT COUNT(*) AS n FROM local_run_sessions"),
    hostedRuns: one("SELECT COUNT(*) AS n FROM runs WHERE mode='practice'"),
    hostedRunsSucceeded: one("SELECT COUNT(*) AS n FROM runs WHERE mode='practice' AND status='succeeded'"),
    officialRuns: one("SELECT COUNT(*) AS n FROM runs WHERE mode='official'"),
    officialAttempts: one("SELECT COUNT(*) AS n FROM official_attempts"),
  };
  db.close();
  return counts;
}

/** Apply the repo's local seed (idempotent) into the fresh persist dir. */
export function seedLocal({ checkoutDir, nodeDir }) {
  const env = { ...process.env };
  if (nodeDir) env.PATH = `${nodeDir}:${env.PATH}`;
  const r = spawnSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "cogportal-db", "--local", `--persist-to=${persistDirFor(checkoutDir)}`, "--file=scripts/seed-local.sql"],
    { cwd: path.join(checkoutDir, "apps", "portal"), encoding: "utf8", env, timeout: 120_000 },
  );
  if (r.status !== 0) {
    throw new Error(`seed-local.sql failed (exit ${r.status}):\n${(r.stderr || "") + (r.stdout || "")}`.slice(-2400));
  }
  return true;
}

// ── Phase: staff + TA assignment (owner-gated admin routes) ──────────────
async function adminPhase({ baseUrl, teamId, log }) {
  const owner = makeClient(baseUrl);
  await devLogin(owner, ROSTER.owner); // owner via .dev.vars PLATFORM_OWNER_LOGINS
  for (const login of ROSTER.staff) {
    await owner("/api/admin/staff", { method: "POST", body: { login } });
  }
  const tas = [];
  for (const login of ROSTER.tas) {
    const client = makeClient(baseUrl);
    await devLogin(client, login); // users must exist before a TA assignment
    tas.push({ login, client });
    await owner(`/api/admin/teams/${teamId}/tas`, { method: "POST", body: { login } });
  }
  log(`staff roster: ${ROSTER.staff.join(", ")}; TAs assigned: ${ROSTER.tas.join(", ")}`);
  return { owner, tas };
}

// ── Phase: cohort, team, joins and leaves ────────────────────────────────
async function teamPhase({ baseUrl, log }) {
  const clients = new Map();

  const creator = makeClient(baseUrl);
  await devLogin(creator, "upg-stu-01");
  clients.set("upg-stu-01", creator);
  await creator("/api/cohorts/join", { method: "POST", body: { code: COHORT_JOIN_CODE } });
  const connected = await creator("/api/github/connect", {
    method: "POST",
    body: { fullName: FIXTURE_REPO_FULL, teamName: "Threshold Titans" },
  });
  let teamId = connected?.team?.id ?? connected?.teamId ?? null;
  if (!teamId) {
    const teams = await creator("/api/cohorts/teams");
    const entries = Array.isArray(teams) ? teams : teams?.teams ?? [];
    const found = entries.find((e) => e?.repoFullName === FIXTURE_REPO_FULL || e?.repo_full_name === FIXTURE_REPO_FULL);
    teamId = found?.id ?? null;
  }
  if (!teamId) throw new Error("could not resolve the fixture team id after /api/github/connect");

  // Members join through the real join path; two demo-mode logins exercise
  // beta's demo onboarding (auto-cohort + auto-connect onto the fixture team).
  for (const login of ["upg-stu-02", "upg-stu-03", "upg-stu-04", "upg-stu-07"]) {
    const client = makeClient(baseUrl);
    await devLogin(client, login);
    clients.set(login, client);
    await client("/api/cohorts/join", { method: "POST", body: { code: COHORT_JOIN_CODE } });
    await client("/api/team/join", { method: "POST", body: { teamId } });
  }
  for (const login of ["upg-stu-05", "upg-stu-06"]) {
    const client = makeClient(baseUrl);
    await devLogin(client, login, true);
    clients.set(login, client);
  }
  // upg-stu-08: cohort only, never teams - a teamless cohort member.
  const solo = makeClient(baseUrl);
  await devLogin(solo, "upg-stu-08");
  clients.set("upg-stu-08", solo);
  await solo("/api/cohorts/join", { method: "POST", body: { code: COHORT_JOIN_CODE } });

  // Leave path: the creator removes upg-stu-07, who rejoins (both directions
  // of the membership journey exist in the log; the snapshot keeps them on).
  await creator("/api/team/members/upg-stu-07", { method: "DELETE" });
  await clients.get("upg-stu-07")("/api/team/join", { method: "POST", body: { teamId } });

  log(`team ${teamId}: 7 memberships via join/connect/leave paths`);
  return { teamId, clients };
}

// ── Phase: hosted fixture runs + official promotions ─────────────────────
async function hostedRunsPhase({ baseUrl, clients, log }) {
  async function pollRun(client, runId, { timeoutMs = 180_000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const detail = await client(`/api/runs/${runId}`);
      const run = detail?.run ?? detail;
      if (run && TERMINAL_RUN_STATUSES.has(run.status)) return run;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`run ${runId} never reached a terminal status (last: ${run?.status})`);
      }
      await sleep(2500);
    }
  }

  async function practiceAndMaybePromote(login, { benchmarkId, branch, promote }) {
    const client = clients.get(login);
    const { runId } = await client("/api/runs/practice", { method: "POST", body: { benchmarkId, branch } });
    const run = await pollRun(client, runId);
    if (!promote || run.status !== "succeeded") {
      return { benchmarkId, login, runId, status: run.status };
    }
    const official = await client(`/api/runs/${runId}/promote`, { method: "POST" });
    const officialRunId = official?.runId;
    const officialRun = officialRunId ? await pollRun(client, officialRunId) : null;
    return { benchmarkId, login, runId, status: run.status, officialRunId, officialStatus: officialRun?.status };
  }

  // One active run per (team, benchmark): queues run per benchmark in
  // parallel, sequentially inside a benchmark.
  const queues = [
    ["vision-recognition", [
      { login: "upg-stu-01", branch: "main", promote: true },
      { login: "upg-stu-02", branch: "improved-thresholds", promote: true },
      { login: "upg-stu-03", branch: "heavy-model", promote: false }, // scripted timeout failure
    ]],
    ["vision-clustering", [
      { login: "upg-stu-04", branch: "main", promote: true },
    ]],
    ["language-search", [
      { login: "upg-stu-05", branch: "main", promote: true },
    ]],
  ];
  const results = (await Promise.all(
    queues.map(async ([benchmarkId, items]) => {
      const out = [];
      for (const item of items) out.push(await practiceAndMaybePromote(item.login, { benchmarkId, ...item }));
      return out;
    }),
  )).flat();
  log(`hosted runs: ${results.map((r) => `${r.benchmarkId}/${r.login}=${r.status}${r.officialStatus ? `->official:${r.officialStatus}` : ""}`).join("; ")}`);
  return results;
}

// ── Phase: pinned CLI - device links, local reports, one live run ────────
async function cliPhase({ repoDir, suiteDir, baseUrl, clients, log }) {
  const quirks = [];
  const cacheDir = path.join(suiteDir, ".cache");
  const pinDir = path.join(cacheDir, "cli-pin");

  // The pin commit is in this repo's history: install the CLI from a local
  // worktree at exactly 064400e (no tokens in URLs, no network install).
  mkdirSync(cacheDir, { recursive: true });
  if (!existsSync(path.join(pinDir, ".git"))) {
    runChecked("git", ["-C", repoDir, "worktree", "add", "--detach", pinDir, CLI_PIN], { timeoutMs: 120_000 });
  } else {
    runChecked("git", ["-C", pinDir, "checkout", "--detach", CLI_PIN], { timeoutMs: 60_000 });
  }

  const venvDir = path.join(cacheDir, "cli-venv");
  const cogworks = path.join(venvDir, "bin", "cogworks");
  if (!existsSync(cogworks)) {
    rmSync(venvDir, { recursive: true, force: true });
    runChecked("python3", ["-m", "venv", venvDir], { timeoutMs: 120_000 });
    runChecked(path.join(venvDir, "bin", "pip"), ["install", "--quiet", path.join(pinDir, "python", "cogbench")], { timeoutMs: 300_000 });
  }

  // Pick the first public week whose benchmark installs and checks on this
  // host; the chosen week is recorded in the receipt either way.
  const examples = readdirSync(path.join(pinDir, "examples"));
  let week = null;
  let exampleDir = null;
  for (const candidate of ["week1", "week2", "week3"]) {
    const dir = examples.find((d) => d.startsWith(candidate));
    if (!dir) continue;
    try {
      runChecked("git", ["-C", pinDir, "submodule", "update", "--init", "--depth", "1", `benchmarks/${candidate}`], { timeoutMs: 420_000 });
    } catch {
      // Shallow clone can miss a pinned submodule SHA; retry unshallow.
      runChecked("git", ["-C", pinDir, "submodule", "update", "--init", `benchmarks/${candidate}`], { timeoutMs: 600_000 });
    }
    const example = path.join(pinDir, "examples", dir);
    try {
      runChecked(cogworks, ["check", "--benchmark", candidate, "--json"], { cwd: example, timeoutMs: 420_000 });
      week = candidate;
      exampleDir = example;
      break;
    } catch (error) {
      quirks.push(`week ${candidate}: cogworks check failed on this host (${String(error).split("\n")[0].slice(0, 200)})`);
    }
  }
  if (!week) throw new Error("no public week benchmark passed `cogworks check` on this host");
  log(`CLI: pinned cogworks installed; week ${week} selected from real public data`);

  // One linked device per student, each with its own config + project copy.
  const device = (login) => {
    const configDir = path.join(cacheDir, "devices", login);
    mkdirSync(configDir, { recursive: true });
    const project = path.join(pinDir, "examples", `${path.basename(exampleDir)}-upg-${login}`);
    if (!existsSync(project)) cpSync(exampleDir, project, { recursive: true });
    return { login, configDir, project, env: { ...process.env, COGBENCH_CONFIG: path.join(configDir, "config.json") } };
  };

  async function linkDevice(login) {
    const d = device(login);
    const child = spawn(cogworks, ["link", "--portal", baseUrl, "--no-browser"], {
      cwd: d.project,
      env: d.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    const userCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`cogworks link never printed a user code (stdout: ${stdout.slice(-300)})`));
      }, 45_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const m = /user_code=([^&\s]+)|confirm code ([A-Z0-9-]+)/.exec(stdout);
        if (m) {
          clearTimeout(timer);
          resolve(m[1] ?? m[2]);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`cogworks link exited early (${code}): ${stdout.slice(-300)}`));
      });
    });
    await clients.get(login)("/v1/cli/device/approve", {
      method: "POST",
      body: { userCode, deviceName: `${login} suite laptop` },
    });
    const exit = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    if (exit !== 0) throw new Error(`cogworks link failed (${exit}): ${stdout.slice(-400)}`);
  }

  for (const login of ["upg-stu-02", "upg-stu-03", "upg-stu-05"]) await linkDevice(login);

  const cli = (login, args, timeoutMs) => {
    const d = device(login);
    return runChecked(cogworks, args, { cwd: d.project, env: d.env, timeoutMs });
  };
  // run --live: local benchmark run + live progress bubble + report upload.
  cli("upg-stu-02", ["run", "--benchmark", week, "--live", "--portal", baseUrl, "--json"], 420_000);
  // Plain run saves a report; sync posts it (with weights) to the Worker.
  cli("upg-stu-03", ["run", "--benchmark", week, "--json"], 420_000);
  cli("upg-stu-03", ["sync", "--portal", baseUrl], 120_000);
  cli("upg-stu-05", ["status", "--portal", baseUrl], 30_000);
  log("CLI: 3 devices linked; run --live + run + sync + status completed against the Worker");
  return { quirks, week };
}

// ── Orchestrator for the phase sequence ──────────────────────────────────
export async function generateBetaState({ checkoutDir, baseUrl, repoDir, suiteDir, log = () => {} }) {
  const timings = {};
  const quirks = [];
  const t0 = Date.now();

  const team = await teamPhase({ baseUrl, log });
  await adminPhase({ baseUrl, teamId: team.teamId, log });
  await hostedRunsPhase({ baseUrl, clients: team.clients, log });
  const cli = await cliPhase({ repoDir, suiteDir, baseUrl, clients: team.clients, log });
  quirks.push(...cli.quirks);

  timings.totalMs = Date.now() - t0;

  // Platform facts learned while driving beta for real - useful to stage 2+.
  quirks.push(
    "one team per (cohort, repository): the fixture repo supports exactly one connect-created team per cohort, and demo:true logins converge onto it",
    "joining the seeded (non-fixture) teams requires a real GitHub token, so dev-auth users can only ever occupy the fixture-repo team",
    "device approval requires an on-team session (requireTeam), so devices link after team joins",
    "fixture runs advance on read by wall clock (~21s end to end); promotion requires the parent practice run to have succeeded",
  );

  return { teamId: team.teamId, quirks, timings, cliWeek: cli.week };
}

/** Assert the generated deltas satisfy the stage's own pass bar. */
export function assertGenerated(generated) {
  const missing = Object.entries(REQUIRED_MIN)
    .filter(([key, min]) => (generated[key] ?? 0) < min)
    .map(([key, min]) => `${key}: ${generated[key] ?? 0} < ${min}`);
  if (missing.length) {
    throw new Error(`generated state below the pass bar: ${missing.join("; ")}`);
  }
  return true;
}
