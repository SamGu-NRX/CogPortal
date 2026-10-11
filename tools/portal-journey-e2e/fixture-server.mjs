/**
 * Synthetic local fixture server for driving the built CogPortal SPA.
 *
 * Serves apps/portal/dist/client statically and answers every /api/* call the
 * connect/setup journey makes with scripted, deterministic responses. No real
 * GitHub, Modal, Discord, D1 or network access is involved; every response is
 * a fixture this file owns. A /__fixture control endpoint lets the walk
 * driver switch scenarios (expire a code, move teams, fail a read) between
 * page states, and every state change is recorded so the walk can assert
 * actual observed sequences.
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const DIST = process.env.DIST_DIR ?? "/home/user/work/CogPortal/apps/portal/dist/client";
const PORT = Number(process.env.PORT ?? 4173);

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

/* ── Fixture state (mutable by the walk driver) ────────────────────────── */

const state = {
  // "first-run" | "expired-code" | "changed-team" | "unavailable-template" | "existing-run"
  scenario: "first-run",
  // Session toggles
  joinedTeam: false,
  teamName: "Face Finder Team",
  teamRepo: { owner: "cogworks-demo", name: "face-finder", fullName: "cogworks-demo/face-finder", url: "https://github.com/cogworks-demo/face-finder", defaultBranch: "main" },
  templateRepo: "SamGu-NRX/cogworks-vision-capstone",
  githubConfigured: true,
  repositories: [
    { repositoryId: 9001, owner: "cogworks-demo", name: "face-finder", fullName: "cogworks-demo/face-finder", url: "https://github.com/cogworks-demo/face-finder", defaultBranch: "main", branches: ["main"], claimedByTeam: null, description: "Vision capstone fork", isFork: true, pushedAt: NOW - 3600_000 },
    { repositoryId: 9002, owner: "cogworks-demo", name: "search-engine", fullName: "cogworks-demo/search-engine", url: "https://github.com/cogworks-demo/search-engine", defaultBranch: "main", branches: ["main"], claimedByTeam: "Search Squad", description: null, isFork: true, pushedAt: NOW - 7200_000 },
  ],
  cohortTeams: [
    { id: "team_search", name: "Search Squad", description: null, provenance: "live", repo: { fullName: "cogworks-demo/search-engine", url: "https://github.com/cogworks-demo/search-engine" }, members: [{ login: "teammate", name: null, avatarUrl: null, role: "admin", isYou: false }], adminLogin: "teammate" },
  ],
  // Evidence state
  verified: [],              // unscoped steps: clone, environment
  verifiedByBenchmark: {},   // benchmarkId -> steps (project, wiring)
  checked: [],
  checkedByBenchmark: {},
  cliDevices: [],
  // Device link codes in flight
  openCode: { userCode: "ABCD-1234-EFGH", valid: true, approved: false, expiresAt: NOW + 600_000 },
  approveShouldFail: false,
  // Read failures to simulate an outage of one evidence source
  failSetupState: false,
  failConnections: false,
  failBenchmarks: false,
  // The benchmarks catalog
  benchmarks: [
    { id: "vision-recognition", version: 1, contractVersion: "cogworks.submissions.v1", entryPointName: "vision-recognition", title: "Vision: Recognition", module: "vision", summary: "Recognise faces.", active: true, pluginVersion: "1.0.0", datasetVersion: "1.0.0", scorerVersion: "1.0.0", runtimeVersion: "1.0.0" },
    { id: "vision-clustering", version: 1, contractVersion: "cogworks.submissions.v1", entryPointName: "vision-clustering", title: "Vision: Clustering", module: "vision", summary: "Cluster faces.", active: true, pluginVersion: "1.0.0", datasetVersion: "1.0.0", scorerVersion: "1.0.0", runtimeVersion: "1.0.0" },
    { id: "language-search", version: 1, contractVersion: "cogworks.submissions.v1", entryPointName: "language-search", title: "Language: Search", module: "language", summary: "Rank passages.", active: true, pluginVersion: "1.0.0", datasetVersion: "1.0.0", scorerVersion: "1.0.0", runtimeVersion: "1.0.0" },
  ],
  requests: [], // log of [method, path] the SPA actually sent
};

function sessionFixture() {
  const team = state.joinedTeam
    ? { id: "team_mine", name: state.teamName, description: null, provenance: "live", repo: state.teamRepo }
    : null;
  return {
    user: { login: "student", name: "Sam Student", avatarUrl: null, platformRole: "student", isOwner: false, isTa: false },
    cohort: { slug: "bwsi-2026", name: "BWSI CogWorks 2026" },
    team,
    auth: {
      githubConfigured: state.githubConfigured,
      devAuthEnabled: true,
      onboardingDevToolsEnabled: false,
      appSlug: "cogworks-portal",
      templateRepo: state.templateRepo,
      executionProvider: "fixture",
    },
  };
}

function setupStateFixture() {
  return {
    verified: [...state.verified],
    verifiedByBenchmark: JSON.parse(JSON.stringify(state.verifiedByBenchmark)),
    checked: [...state.checked],
    checkedByBenchmark: JSON.parse(JSON.stringify(state.checkedByBenchmark)),
    tokens: {
      clone: "tok-clone", environment: "tok-environment", project: "tok-project",
    },
  };
}

function connectionsFixture() {
  return {
    github: { id: 42, login: "student", avatarUrl: null },
    discord: null,
    cliDevices: state.cliDevices.map((d, i) => ({ id: `dev_${i}`, name: d, createdAt: NOW - 60_000, lastUsedAt: null })),
  };
}

function teamDetailFixture() {
  return {
    id: "team_mine",
    name: state.teamName,
    description: null,
    provenance: "live",
    repo: state.teamRepo,
    members: [{ login: "student", name: "Sam Student", avatarUrl: null, role: "admin", isYou: true }],
    tas: [],
    isAdmin: true,
  };
}

/* ── HTTP plumbing ─────────────────────────────────────────────────────── */

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff",
};

async function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  let file = join(DIST, normalize(rel));
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("dir");
  } catch {
    file = join(DIST, "index.html"); // SPA fallback
  }
  const body = await readFile(file);
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(body);
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (path.startsWith("/__fixture")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const patch = body ? JSON.parse(body) : {};
    if (patch.scenario !== undefined) Object.assign(state, scenarioState(patch.scenario));
    else Object.assign(state, patch);
    json(res, 200, { ok: true });
    return;
  }

  if (path.startsWith("/api/")) {
    state.requests.push([req.method, path]);
    console.log(`[fixture] ${req.method} ${path}${url.search ? url.search : ""}`);
    const trackId = url.searchParams.get("benchmarkId") ?? "vision-recognition";

    if (path === "/api/session") return json(res, 200, sessionFixture());
    if (path === "/api/dev/login") { state.joinedTeam = false; return json(res, 200, sessionFixture()); }
    if (path === "/api/cohorts/teams") return json(res, 200, state.cohortTeams);
    if (path === "/api/github/repositories") return json(res, 200, state.repositories);
    if (path === "/api/github/installations") return json(res, 200, [{ id: 7, account: "cogworks-demo", accountType: "User", avatarUrl: null }]);
    if (path === "/api/github/connect") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { fullName, teamName } = JSON.parse(body);
      const repo = state.repositories.find((r) => r.fullName === fullName) ?? state.repositories[0];
      state.teamRepo = { owner: repo.owner, name: repo.name, fullName: repo.fullName, url: repo.url, defaultBranch: repo.defaultBranch };
      state.teamName = teamName || "Face Finder Team";
      state.joinedTeam = true;
      return json(res, 200, sessionFixture());
    }
    if (path === "/api/team/join") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { teamId } = JSON.parse(body);
      const team = state.cohortTeams.find((t) => t.id === teamId);
      if (!team) return json(res, 404, { error: { code: "not_found", message: "Team not found." } });
      state.joinedTeam = true;
      state.teamName = team.name;
      state.teamRepo = { owner: "cogworks-demo", name: "search-engine", fullName: "cogworks-demo/search-engine", url: team.repo.url, defaultBranch: "main" };
      return json(res, 200, teamDetailFixture());
    }
    if (path === "/api/team") return json(res, 200, teamDetailFixture());
    if (path === "/api/benchmarks") {
      if (state.failBenchmarks) return json(res, 500, { error: { code: "unknown", message: "catalog unavailable" } });
      return json(res, 200, state.benchmarks);
    }
    if (path === "/api/v1/connections") {
      if (state.failConnections) return json(res, 500, { error: { code: "unknown", message: "connections unavailable" } });
      return json(res, 200, connectionsFixture());
    }
    if (path === "/api/v1/setup/state") {
      if (state.failSetupState) return json(res, 500, { error: { code: "unknown", message: "setup state unavailable" } });
      return json(res, 200, setupStateFixture());
    }
    if (path === "/api/v1/cli/device/status") {
      const code = url.searchParams.get("user_code") ?? "";
      if (code !== state.openCode.userCode) return json(res, 200, { valid: false, approved: false, expiresAt: null });
      return json(res, 200, { valid: state.openCode.valid, approved: state.openCode.approved, expiresAt: state.openCode.expiresAt });
    }
    if (path === "/api/v1/cli/device/approve") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { userCode } = JSON.parse(body);
      if (state.approveShouldFail || userCode !== state.openCode.userCode) {
        return json(res, 410, { error: { code: "link_expired", message: "The device code is invalid, expired, or already used." } });
      }
      state.cliDevices.push("Sam's laptop");
      state.openCode.approved = true;
      return json(res, 200, { ok: true });
    }
    if (path === "/api/v1/setup/check-off") {
      const token = url.searchParams.get("t") ?? "";
      const step = { "tok-clone": "clone", "tok-environment": "environment", "tok-project": "project" }[token];
      if (!step) return json(res, 400, { error: { code: "unknown", message: "CogPortal: this check-off command is stale. Copy a fresh one from the setup page." } });
      const scoped = ["environment", "project"].includes(step);
      if (scoped) {
        state.checkedByBenchmark[trackId] = [...new Set([...(state.checkedByBenchmark[trackId] ?? []), step])];
      } else {
        state.checked = [...new Set([...state.checked, step])];
      }
      return json(res, 200, { ok: true });
    }
    if (path === "/api/v1/cli/setup/checks") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      for (const step of payload.checks ?? []) {
        const scoped = ["environment", "project", "wiring"].includes(step);
        if (scoped) {
          const b = payload.checkedBenchmarkId ?? trackId;
          state.verifiedByBenchmark[b] = [...new Set([...(state.verifiedByBenchmark[b] ?? []), step])];
        } else {
          state.verified = [...new Set([...state.verified, step])];
        }
      }
      return json(res, 200, { accepted: payload.checks ?? [] });
    }
    // Everything else the SPA might probe on these pages: answer empty and log it.
    console.log(`[fixture] unhandled api route: ${req.method} ${path}`);
    return json(res, 200, null);
  }

  await serveStatic(req, res, path);
});

/** Clean evidence state; scenarios spread this so no walk leaks into the next. */
function resetEvidence() {
  return { verified: [], verifiedByBenchmark: {}, checked: [], checkedByBenchmark: {}, cliDevices: [] };
}

/** Scenario presets; the driver switches between them through /__fixture. */
function scenarioState(scenario) {
  switch (scenario) {
    case "first-run":
      return {
        joinedTeam: false, templateRepo: "SamGu-NRX/cogworks-vision-capstone",
        ...resetEvidence(),
        repositories: [{ repositoryId: 9001, owner: "cogworks-demo", name: "face-finder", fullName: "cogworks-demo/face-finder", url: "https://github.com/cogworks-demo/face-finder", defaultBranch: "main", branches: ["main"], claimedByTeam: null, description: "Vision capstone fork", isFork: true, pushedAt: NOW - 3600_000 }],
        cohortTeams: [], failSetupState: false, failConnections: false, approveShouldFail: false,
        openCode: { userCode: "ABCD-1234-EFGH", valid: true, approved: false, expiresAt: Date.now() + 600_000 },
      };
    case "first-run-with-teams":
      return {
        joinedTeam: false, templateRepo: "SamGu-NRX/cogworks-vision-capstone",
        ...resetEvidence(),
        cohortTeams: [{ id: "team_search", name: "Search Squad", description: null, provenance: "live", repo: { fullName: "cogworks-demo/search-engine", url: "https://github.com/cogworks-demo/search-engine" }, members: [{ login: "teammate", name: null, avatarUrl: null, role: "admin", isYou: false }], adminLogin: "teammate" }],
        openCode: { userCode: "ABCD-1234-EFGH", valid: true, approved: false, expiresAt: Date.now() + 600_000 },
      };
    case "expired-code":
      return {
        joinedTeam: true, approveShouldFail: true, ...resetEvidence(),
      };
    case "changed-team":
      return {
        // The student has left Face Finder, so /connect is reachable again and
        // the join flow runs end to end; joining sets teamRepo via /api/team/join.
        joinedTeam: false, teamRepo: null,
        ...resetEvidence(),
        cohortTeams: [{ id: "team_search", name: "Search Squad", description: null, provenance: "live", repo: { fullName: "cogworks-demo/search-engine", url: "https://github.com/cogworks-demo/search-engine" }, members: [{ login: "teammate", name: null, avatarUrl: null, role: "admin", isYou: false }], adminLogin: "teammate" }],
        repositories: [{ repositoryId: 9002, owner: "cogworks-demo", name: "search-engine", fullName: "cogworks-demo/search-engine", url: "https://github.com/cogworks-demo/search-engine", defaultBranch: "main", branches: ["main"], claimedByTeam: "Search Squad", description: null, isFork: true, pushedAt: NOW - 7200_000 }],
      };
    case "unavailable-template":
      return {
        joinedTeam: false, templateRepo: null, cohortTeams: [],
        ...resetEvidence(),
        repositories: [],
      };
    case "existing-run":
      return {
        joinedTeam: true, templateRepo: "SamGu-NRX/cogworks-vision-capstone",
        verified: ["clone"], verifiedByBenchmark: { "language-search": ["environment", "project", "wiring"] }, checked: [], checkedByBenchmark: {},
        cliDevices: ["Sam's laptop"],
      };
    default:
      return {};
  }
}

server.listen(PORT, () => console.log(`fixture server on ${PORT}, dist ${DIST}`));
