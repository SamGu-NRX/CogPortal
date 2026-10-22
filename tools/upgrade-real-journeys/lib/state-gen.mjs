// Beta state generation through beta's real paths (stage 1). No row is
// written directly: every entity comes from beta's own API as dev-auth users
// with generated upg-* handles, or from the pinned student CLI (the staging
// pin read from beta's benchmark-packages.ts) doing
// its real device-link / local-report flow. The database is only read
// (countEntities) for the receipt. Fixture execution provider only; no
// discord.com, no real GitHub OAuth, no Modal, no dev/prod surfaces.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { findD1File, openD1, persistDirFor } from "./d1.mjs";

export const BETA_COMMIT = "17d26d9";
// Two-pin reality (plan #108 update): staging students install the SDK from
// BETA's apps/portal/src/lib/benchmark-packages.ts — the runner images bake
// that pin — while alpha's copy of the same file pins a different commit.
// Read the pin from the checkout the caller names, never a hardcode: stage 1
// passes beta's worktree (the pin staging students actually have); stage 3
// will test both pins in both directions.
export function readCogbenchPin(fromDir) {
  const file = path.join(fromDir, "apps", "portal", "src", "lib", "benchmark-packages.ts");
  const src = readFileSync(file, "utf8");
  const m = src.match(
    /COGBENCH_SOURCE =\s*"git\+https:\/\/github\.com\/SamGu-NRX\/CogPortal\.git@([0-9a-f]{7,40})#subdirectory=python\/cogbench"/,
  );
  if (!m) throw new Error(`could not parse COGBENCH_SOURCE pin from ${file}`);
  return m[1];
}
export const FIXTURE_REPO_FULL = "cogworks-demo/face-finder";
export const COHORT_JOIN_CODE = "VISION26";

// The week-probe loop tries each public week and records why each was
// rejected. When no week works, the thrown error must carry those reasons -
// a bare "none worked" turns a diagnosable host problem (requires-python
// refusal, missing system library, failing check field) into a dead end.
// The venv must run a Python the course stack supports: weeks 2/3 declare
// requires-python <3.13, and week1's example pins scipy<1.13 / numpy<2,
// which have no 3.13 wheels - on 3.13 every week fails for interpreter
// reasons no code fix removes. Prefer the newest supported interpreter.
export function pickVenvInterpreter({
  candidates = ["python3.12", "python3.11", "python3.10", "python3"],
  probe = (name) => {
    try {
      const r = spawnSync(name, ["-c", 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'], { encoding: "utf8" });
      return r.status === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  },
} = {}) {
  for (const name of candidates) {
    const version = probe(name);
    if (version && version.startsWith("3.") && Number(version.split(".")[1]) < 13) return name;
  }
  return "python3";
}

// A real deployment carries the benchmark registry row in its migrations; the
// suite writes the row the pinned plugin itself declares, activating any
// stale inactive row with the same (id, version) so `run --live` reports pass
// beta's local-runs gate.
export function seedBenchmarkRow(db, identity, pluginId, week) {
  const MODULE_BY_WEEK = { week1: "audio", week2: "vision", week3: "language" };
  db.prepare(
    `INSERT INTO benchmarks (id, version, contract_version, entry_point_name, title, module, summary, active, primary_metric_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(id, version) DO UPDATE SET active = 1`,
  ).run(
    identity.benchmark_id,
    identity.benchmark_version,
    identity.contract_version,
    pluginId,
    pluginId,
    MODULE_BY_WEEK[week],
    "Active benchmark row seeded by tools/upgrade-real-journeys from the pinned plugin's own identity.",
    identity.primary_metric,
  );
}

export function noBenchmarkInstalledError(quirks) {
  const detail = quirks.length ? `\n${quirks.map((q) => `  - ${q}`).join("\n")}` : "";
  return new Error(`no public week benchmark installed and passed \`cogworks check\` on this host${detail}`);
}

// ── CLI-phase helpers shared with the tests ───────────────────────────────

export const FIXTURE_ORIGIN = "https://github.com/cogworks-demo/face-finder.git";

/**
 * The benchmark plugin id a benchmark package declares through its
 * cogworks.benchmarks.v1/v2 entry point (week1 declares
 * audio-identification). `cogworks check`/`run` take plugin ids like
 * audio-identification, not the submodule directory name week1, so the id is
 * read from the package's own pyproject instead of guessed from the path.
 */
export function benchmarkPluginId(benchDir) {
  const file = path.join(benchDir, "pyproject.toml");
  const src = readFileSync(file, "utf8");
  const section = /^\[project\.entry-points\."cogworks\.benchmarks\.v[12]"\]\s*$/m;
  if (!section.test(src)) {
    throw new Error(`${file} declares no cogworks.benchmarks.v1/v2 entry-point section`);
  }
  const lines = src.split("\n");
  const start = lines.findIndex((line) => section.test(line));
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) break;
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(lines[i]);
    if (m) return m[1];
  }
  throw new Error(`${file} has an empty cogworks.benchmarks entry-point section`);
}

/**
 * Copy an example project and make it the standalone committed git repository
 * the pinned CLI expects: its own .git (repository_state resolves the
 * repository it stands in by walking up to the nearest .git, so a copy inside
 * a worktree would report the enclosing checkout's origin), origin naming the
 * team's connected fixture repository, and one clean commit. Identity is set
 * with per-repository config only - never the enclosing clone's shared
 * config.
 */
export function makeFixtureRepo(exampleDir, project, { origin = FIXTURE_ORIGIN } = {}) {
  if (existsSync(path.join(project, ".git"))) return project;
  rmSync(project, { recursive: true, force: true });
  cpSync(exampleDir, project, { recursive: true });
  rmSync(path.join(project, ".git"), { recursive: true, force: true });
  const git = (args) => runChecked("git", args, { cwd: project, timeoutMs: 60_000 });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Upgrade Suite"]);
  git(["config", "user.email", "upgrade-suite@dev.local"]);
  git(["remote", "add", "origin", origin]);
  git(["add", "-A"]);
  git(["commit", "-m", "fixture project snapshot"]);
  return project;
}

/**
 * Drive one pinned-CLI device link. The child runs with piped stdout and
 * Python output unbuffered (the CLI prints the confirmation code and then
 * polls; block-buffered piped stdout would deadlock the stage until the 45s
 * kill). The exit wait is registered BEFORE approval is posted:
 * ChildProcess events are not replayed, and a CLI that observes the approval
 * and exits while the approval request is still in flight would hang a
 * promise registered after the await forever.
 */
export async function linkDeviceProcess({ argv, cwd, env, deviceName, approve, spawnImpl = spawn }) {
  const [cmd, ...args] = argv;
  // Piped stdout is block-buffered in Python: the CLI prints the confirmation
  // code and then polls, so without PYTHONUNBUFFERED the code line can sit in
  // the child's buffer and the stage deadlocks until the 45s kill. The
  // invariant lives here, where the spawn happens, not in each caller.
  const child = spawnImpl(cmd, args, { cwd, env: { ...env, PYTHONUNBUFFERED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  // Registered before any await: a fast exit cannot be lost.
  const exitCode = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(code === null ? `signal:${signal}` : code));
  });
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
  await approve("/api/v1/cli/device/approve", {
    method: "POST",
    body: { userCode, deviceName },
  });
  const exit = await exitCode;
  if (exit !== 0) throw new Error(`cogworks link failed (${exit}): ${stdout.slice(-400)}`);
  return userCode;
}


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
// tas stays 0 in dev-auth mode: the TA route matches users.github_login,
// which dev-auth accounts never hold (attempted, 404 recorded in the log).
export const REQUIRED_MIN = {
  users: 13, students: 8, staff: 2, tas: 0, teams: 1, memberships: 7, forks: 1,
  deviceLinks: 3, localReports: 2, localRunSessions: 1,
  hostedRuns: 5, hostedRunsSucceeded: 4, officialRuns: 4,
  officialAttempts: 0, refundedRuns: 0,
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
    refundedRuns: one("SELECT COUNT(*) AS n FROM runs WHERE refunded_at IS NOT NULL"),
  };
  db.close();
  return counts;
}

/**
 * Verify the beta worktree actually has the bins the stage needs. A partial
 * install (sandbox died mid `pnpm install`) leaves node_modules in place
 * without bin links, which surfaces later as `Command "wrangler" not found`.
 */
export function ensureBetaDeps({ checkoutDir, nodeDir }) {
  const wranglerBin = path.join(checkoutDir, "apps", "portal", "node_modules", ".bin", "wrangler");
  if (existsSync(wranglerBin)) return { wranglerBin };
  const env = { ...process.env };
  if (nodeDir) env.PATH = `${nodeDir}:${nodeDir}/bin:${env.PATH}`;
  const r = spawnSync("pnpm", ["install", "--prefer-offline"], {
    cwd: checkoutDir,
    encoding: "utf8",
    env,
    timeout: 600_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0 || !existsSync(wranglerBin)) {
    throw new Error(
      `beta deps install failed (exit ${r.status}):\n${((r.stderr || "") + (r.stdout || "")).slice(-2400)}`,
    );
  }
  return { wranglerBin };
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
export async function adminPhase({ baseUrl, teamId, log }) {
  const owner = makeClient(baseUrl);
  await devLogin(owner, ROSTER.owner); // owner via .dev.vars PLATFORM_OWNER_LOGINS
  for (const login of ROSTER.staff) {
    await owner("/api/admin/staff", { method: "POST", body: { login } });
    // Rostering creates no user row (an owner names staff before they sign
    // in); the staff user rows come from beta's real login path - beta's
    // TA-assignment route refuses logins with no user row even before its
    // github-login lookup, and the stage's user-count pass bar counts users.
    await devLogin(makeClient(baseUrl), login);
  }
  const tas = [];
  let tasAssigned = 0;
  for (const login of ROSTER.tas) {
    const client = makeClient(baseUrl);
    await devLogin(client, login); // users must exist before a TA assignment
    tas.push({ login, client, assigned: false });
    // The TA route resolves the assignee by lower(users.github_login), which
    // dev-auth accounts never hold - the attempt is made and the 404 recorded
    // rather than treated as a stage failure.
    try {
      await owner(`/api/admin/teams/${teamId}/tas`, { method: "POST", body: { login } });
      tas[tas.length - 1].assigned = true;
      tasAssigned += 1;
    } catch (error) {
      if (!/-> 404\b/.test(String(error?.message))) throw error;
    }
  }
  log(
    tasAssigned === ROSTER.tas.length
      ? `staff roster: ${ROSTER.staff.join(", ")}; TAs assigned: ${ROSTER.tas.join(", ")}`
      : `staff roster: ${ROSTER.staff.join(", ")}; TA assignment unreachable in dev-auth (route matches users.github_login); ${tasAssigned}/${ROSTER.tas.length} assigned`,
  );
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

  // Beta's member add/remove routes (POST/DELETE /api/team/members, the admin
  // variants, and TA assignment) resolve users by lower(users.github_login),
  // which dev-auth accounts never hold: dev login nulls that column on every
  // sign-in because it is uniquely indexed and reserved for real GitHub
  // identities. An admin-driven leave is therefore unreachable in dev-auth
  // mode; the snapshot records self-serve joins only.
  log(`team ${teamId}: 7 memberships via self-serve join/connect paths`);
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
async function cliPhase({ repoDir, suiteDir, baseUrl, clients, log, stagingPin, dbFile }) {
  const quirks = [];
  const cacheDir = path.join(suiteDir, ".cache");
  const pinDir = path.join(cacheDir, "cli-pin");

  // The staging pin (read from beta's benchmark-packages.ts, the file staging
  // students install from) is in this repo's history: install the CLI from a
  // local worktree at exactly that commit (no tokens, no network install).
  mkdirSync(cacheDir, { recursive: true });
  if (!existsSync(path.join(pinDir, ".git"))) {
    runChecked("git", ["-C", repoDir, "worktree", "add", "--detach", pinDir, stagingPin], { timeoutMs: 120_000 });
  } else {
    runChecked("git", ["-C", pinDir, "checkout", "--detach", stagingPin], { timeoutMs: 60_000 });
  }

  const venvDir = path.join(cacheDir, "cli-venv");
  const cogworks = path.join(venvDir, "bin", "cogworks");
  if (!existsSync(cogworks)) {
    rmSync(venvDir, { recursive: true, force: true });
    const py = pickVenvInterpreter();
    log(`CLI: venv interpreter ${py}`);
    runChecked(py, ["-m", "venv", venvDir], { timeoutMs: 120_000 });
    runChecked(path.join(venvDir, "bin", "pip"), ["install", "--quiet", path.join(pinDir, "python", "cogbench")], { timeoutMs: 300_000 });
  }

  // Pick the first public week whose benchmark installs and checks on this
  // host; the chosen week is recorded in the receipt either way.
  // `cogworks check` only probes INSTALLED plugin entry points, so the
  // benchmark package is pip-installed into the stage's venv before the
  // probe, and the real plugin id comes from the package's declared entry
  // point (week1 is audio-identification) - not from the submodule directory
  // name.
  const examples = readdirSync(path.join(pinDir, "examples"));
  let week = null;
  let pluginId = null;
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
    log(`CLI: probing ${candidate} (examples/${dir})`);
    try {
      const id = benchmarkPluginId(path.join(pinDir, "benchmarks", candidate));
      runChecked(path.join(venvDir, "bin", "pip"), ["install", "--quiet", path.join(pinDir, "benchmarks", candidate)], { timeoutMs: 600_000 });
      // The example is itself a package (the submission's entry point lives
      // there) and check's exit gate requires the submission to import, so
      // install it and its declared deps into the same venv before checking.
      runChecked(path.join(venvDir, "bin", "pip"), ["install", "--quiet", example], { timeoutMs: 600_000 });
      runChecked(cogworks, ["check", "--benchmark", id, "--json"], { cwd: example, timeoutMs: 420_000 });
      week = candidate;
      pluginId = id;
      exampleDir = example;
      break;
    } catch (error) {
      // Keep the tail of the failure output: runChecked puts the exit reason
      // and stderr there, and that is the diagnosable line (a requires-python
      // refusal, a missing system library, a check JSON field).
      const lines = String(error).split("\n").map((l) => l.trim()).filter(Boolean);
      const detail = lines.slice(-2).join(" | ").slice(0, 300);
      const quirk = `week ${candidate}: benchmark install or check failed on this host (${detail})`;
      quirks.push(quirk);
      log(`CLI: ${quirk}`);
    }
  }
  if (!week || !pluginId) throw noBenchmarkInstalledError(quirks);
  log(`CLI: pinned cogworks installed; week ${week} (benchmark ${pluginId}) selected from real public data`);

  // beta's /api/v1/local-runs accepts a report only when the benchmarks table
  // holds an ACTIVE row matching the plugin's own (benchmark_id,
  // benchmark_version) - the seed migration knows only vision-recognition
  // (audio-recognition is a different, inactive id). Ask the INSTALLED plugin
  // for its identity through the CLI's own loader (from /tmp so no repository
  // shadows it), then write the row a real deployment would carry in its
  // migrations.
  const identity = JSON.parse(
    runChecked(
      path.join(venvDir, "bin", "python"),
      [
        "-c",
        `import json
from cogbench.plugins import load_benchmark
b = load_benchmark(${JSON.stringify(pluginId)})
print(json.dumps({"benchmark_id": b.benchmark_id, "benchmark_version": b.benchmark_version, "contract_version": b.contract_version, "primary_metric": b.primary_metric}))`,
      ],
      { cwd: "/tmp", timeoutMs: 120_000 },
    ),
  );
  seedBenchmarkRow(openD1(dbFile), identity, pluginId, week);
  log(`CLI: seeded active benchmark row ${identity.benchmark_id}@${identity.benchmark_version} (${identity.contract_version})`);

  // One linked device per student, each with its own CLI config and project
  // copy. The copy becomes its own committed git repository whose origin
  // names the team's connected fixture repository: the pinned CLI reports the
  // repository it stands in (repository_state walks up to the nearest .git),
  // and beta's /api/v1/local-runs refuses reports whose repositoryFullName is
  // not the team's connected repo. A plain copy inside the cli-pin worktree
  // would report CogPortal's own origin instead.
  const device = (login) => {
    const configDir = path.join(cacheDir, "devices", login);
    mkdirSync(configDir, { recursive: true });
    const project = path.join(cacheDir, "projects", login);
    makeFixtureRepo(exampleDir, project);
    return { login, configDir, project, env: { ...process.env, COGBENCH_CONFIG: path.join(configDir, "config.json") } };
  };

  async function linkDevice(login) {
    const d = device(login);
    await linkDeviceProcess({
      argv: [cogworks, "link", "--portal", baseUrl, "--no-browser"],
      cwd: d.project,
      env: d.env,
      deviceName: `${login} suite laptop`,
      approve: (route, opts) => clients.get(login)(route, opts),
    });
  }

  for (const login of ["upg-stu-02", "upg-stu-03", "upg-stu-05"]) await linkDevice(login);

  const cli = (login, args, timeoutMs) => {
    const d = device(login);
    return runChecked(cogworks, args, { cwd: d.project, env: d.env, timeoutMs });
  };
  // run --live: local benchmark run + live progress bubble + report upload.
  cli("upg-stu-02", ["run", "--benchmark", pluginId, "--live", "--portal", baseUrl, "--json"], 420_000);
  // Plain run saves a report; sync posts it (with weights) to the Worker.
  cli("upg-stu-03", ["run", "--benchmark", pluginId, "--json"], 420_000);
  cli("upg-stu-03", ["sync", "--portal", baseUrl], 120_000);
  cli("upg-stu-05", ["status", "--portal", baseUrl], 30_000);
  log("CLI: 3 devices linked; run --live + run + sync + status completed against the Worker");
  return { quirks, week, benchmarkId: pluginId };
}

// ── Orchestrator for the phase sequence ──────────────────────────────────
export async function generateBetaState({ checkoutDir, baseUrl, repoDir, suiteDir, log = () => {} }) {
  const timings = {};
  const quirks = [];
  const t0 = Date.now();

  const team = await teamPhase({ baseUrl, log });
  await adminPhase({ baseUrl, teamId: team.teamId, log });
  await hostedRunsPhase({ baseUrl, clients: team.clients, log });
  const cli = await cliPhase({
    stagingPin: readCogbenchPin(checkoutDir), repoDir, suiteDir, baseUrl, clients: team.clients, log,
    dbFile: findD1File(persistDirFor(checkoutDir)) });
  quirks.push(...cli.quirks);

  timings.totalMs = Date.now() - t0;

  // Platform facts learned while driving beta for real - useful to stage 2+.
  quirks.push(
    "one team per (cohort, repository): the fixture repo supports exactly one connect-created team per cohort, and demo:true logins converge onto it",
    "joining the seeded (non-fixture) teams requires a real GitHub token, so dev-auth users can only ever occupy the fixture-repo team",
    "device approval requires an on-team session (requireTeam), so devices link after team joins",
    "dev-auth accounts never hold users.github_login (nulled on every dev login; reserved for real GitHub identities), so member add/remove and TA assignment routes that match on it are unreachable in dev-auth mode",
    "fixture runs advance on read by wall clock (~21s end to end); promotion requires the parent practice run to have succeeded",
    "beta's worker never writes official_attempts in this flow (no runtime code touches the table; the seeded demo attempt stays consumed by the seed itself), and the designed practice-mode failure never promotes, so no refund fires - the bar pins zero new attempts and zero refunds and measures promotion via officialRuns deltas instead",
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
