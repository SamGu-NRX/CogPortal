// S5, authorization at the API: every route the Worker registers, called by
// every identity, with the exact answer each one must get.
//
// The route list is the Worker's own (`app.routes`, printed by
// apps/portal/scripts/list-routes.ts), so a route added without a row here
// fails the journey instead of going untested. Each route has one request
// (REQUESTS below) that every identity sends; the policy
// (route-policy.mjs) groups identities by the exact status, error code and
// message they must receive. A request is chosen so that a caller the guard
// admits changes nothing others depend on; each route also has a positive
// control (POSITIVE), a request that must succeed for a caller the policy
// allows, run after every cell.
//
// RJ_MATRIX_OBSERVE=1 records what the Worker answers instead of asserting,
// to test-results/evidence/route-matrix-observed.json, for writing the policy
// after a route change, and then fails (helpers.mjs matrixMode). The policy
// is reviewed, not regenerated blindly.

import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ACTIVITY, STACK, control, expectNoDispatch, failObserved, fresh, matrixMode } from "./helpers.mjs";
import { REPO_ROOT } from "./cli.mjs";
import { LOGINS, activitySession, buildWorld, call, devLogin, worldFacts } from "./world.mjs";
import { TEAM_A, TEAM_B, leaks, plantCanaries } from "./canaries.mjs";
import { CONTENT } from "./route-content.mjs";
import { IDENTITIES, NO_POSITIVE, POLICY } from "./route-policy.mjs";

const PORTAL = path.join(REPO_ROOT, "apps", "portal");

/** The Worker's registered routes, from the Hono app itself. */
export function workerRoutes() {
  const out = execFileSync(path.join(PORTAL, "node_modules", ".bin", "tsx"), ["scripts/list-routes.ts"], {
    cwd: PORTAL,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TSX_TSCONFIG_PATH: "tsconfig.app.json" },
  });
  return JSON.parse(out).map((route) => `${route.method} ${route.path}`);
}

const ZERO_SHA = "0".repeat(40);
const hex = (n) => Array.from({ length: n }, (_, i) => "0123456789abcdef"[(i * 7 + 3) % 16]).join("");

function report(w, reportId) {
  return {
    reportId,
    benchmarkId: "audio-identification",
    benchmarkVersion: w.versions["audio-identification"],
    contractVersion: "cogworks.submissions.v2",
    sdkVersion: "0.2.0",
    pluginVersion: "0.1.0",
    repositoryId: null,
    repositoryFullName: w.repoA,
    sha: ZERO_SHA.replace(/^0/, "a"),
    dirty: false,
    startedAt: 1_790_000_000_000,
    finishedAt: 1_790_000_060_000,
    metrics: [{ key: "top1", label: "Top-1", value: 0.5, unit: null, higherIsBetter: true, primary: true, precision: 3, role: "scored" }],
    diagnostics: ["rj matrix report"],
    weightsUsed: [],
    weightsUploaded: [],
    command: "run",
  };
}

/**
 * One request per route, sent by every identity. Values come from the world
 * (`w.ids`, `w.versions`, `w.repoA`). Writes name nothing that exists, or
 * repeat a state that already holds, unless the route's whole point is the
 * team-A resource (then refusing other teams is what the cell checks).
 */
const REQUESTS = {
  "ALL /api/auth/*": () => ({ method: "GET", path: "/api/auth/get-session" }),
  "GET /api/session": () => ({ path: "/api/session" }),
  "POST /api/dev/login": () => ({ path: "/api/dev/login", body: { login: "bad login!" } }),
  "POST /api/session/logout": null, // runs last for each identity; see LAST
  "POST /api/cohorts/join": () => ({ path: "/api/cohorts/join", body: { code: "NOPE-NOPE" } }),
  "GET /api/github/login": () => ({ path: "/api/github/login" }),
  "GET /api/github/repositories": () => ({ path: "/api/github/repositories" }),
  "POST /api/github/connect": () => ({ path: "/api/github/connect", body: { fullName: "octocat/hello-world", teamName: "rj-m" } }),
  "GET /api/github/installations": () => ({ path: "/api/github/installations" }),
  "POST /api/github/webhook": () => ({ path: "/api/github/webhook", body: { zen: "rj" } }),
  "POST /api/runs/practice": (w) => ({ path: "/api/runs/practice", body: { teamId: "team_not_shown", benchmarkId: w.activeBenchmark } }),
  "POST /api/runs/:id/promote": () => ({ path: "/api/runs/run_rj_missing/promote" }),
  "GET /api/runs": () => ({ path: "/api/runs" }),
  "GET /api/v1/runs/:id/weights/*": (w) => ({ path: `/api/v1/runs/${w.ids.runA}/weights/model.npz` }),
  "GET /api/runs/:id": (w) => ({ path: `/api/runs/${w.ids.runA}` }),
  "GET /api/dashboard": () => ({ path: "/api/dashboard" }),
  "PUT /api/leaderboard-selection": () => ({ path: "/api/leaderboard-selection", body: { runId: "run_rj_missing" } }),
  "GET /api/leaderboard": () => ({ path: "/api/leaderboard" }),
  "GET /api/v1/leaderboard": () => ({ path: "/api/v1/leaderboard" }),
  "GET /api/leaderboard-family": () => ({ path: "/api/leaderboard-family" }),
  "GET /api/benchmarks": () => ({ path: "/api/benchmarks" }),
  "GET /api/v1/benchmarks": () => ({ path: "/api/v1/benchmarks" }),
  "GET /api/team": () => ({ path: "/api/team" }),
  "GET /api/v1/team/process": () => ({ path: "/api/v1/team/process" }),
  "PATCH /api/team": (w) => ({ path: "/api/team", body: { teamId: w.ids.teamA, name: "Demo Team" } }),
  "POST /api/team/repository": (w) => ({ path: "/api/team/repository", body: { teamId: w.ids.teamA, fullName: w.repoA } }),
  "GET /api/cohorts/teams": () => ({ path: "/api/cohorts/teams" }),
  "POST /api/team/join": () => ({ path: "/api/team/join", body: { teamId: "team_rj_missing" } }),
  "POST /api/team/leave": () => ({ path: "/api/team/leave", body: { teamId: "team_rj_missing" } }),
  "GET /api/team/invitable": () => ({ path: "/api/team/invitable" }),
  "POST /api/team/members": (w) => ({ path: "/api/team/members", body: { teamId: w.ids.teamA, login: "rj-m-nobody" } }),
  "DELETE /api/team/members/:login": (w) => ({ method: "DELETE", path: `/api/team/members/rj-m-nobody?teamId=${w.ids.teamA}` }),
  "GET /api/v1/connections": () => ({ path: "/api/v1/connections" }),
  "POST /api/v1/connections/discord/preview": () => ({ path: "/api/v1/connections/discord/preview", body: { token: "0".repeat(64) } }),
  "POST /api/v1/connections/discord/confirm": () => ({ path: "/api/v1/connections/discord/confirm", body: { token: "0".repeat(64) } }),
  "DELETE /api/v1/connections/discord": null, // LAST: it unlinks the caller's Discord
  "POST /api/v1/cli/device/start": () => ({ path: "/api/v1/cli/device/start" }),
  "POST /api/v1/cli/device/approve": () => ({ path: "/api/v1/cli/device/approve", body: { userCode: "ZZZZ-ZZZZ", deviceName: "rj-m" } }),
  "POST /api/v1/cli/device/token": () => ({ path: "/api/v1/cli/device/token", body: { deviceCode: "0".repeat(64) } }),
  "DELETE /api/v1/cli/devices": () => ({ method: "DELETE", path: "/api/v1/cli/devices", body: { deviceId: "device_rj_missing" } }),
  "GET /api/v1/cli/device/status": () => ({ path: "/api/v1/cli/device/status" }),
  "POST /api/v1/local-reports": (w) => ({ path: "/api/v1/local-reports", body: report(w, "rj-matrix-report-0001") }),
  "PUT /api/v1/local-reports/:reportId/weights/*": () => ({
    method: "PUT",
    path: "/api/v1/local-reports/rj-matrix-missing/weights/model.npz",
    body: "x",
    headers: { "content-type": "application/octet-stream", "x-cogworks-weight-sha256": "0".repeat(64) },
  }),
  "GET /api/v1/local-reports": () => ({ path: "/api/v1/local-reports" }),
  "POST /api/v1/local-runs": (w) => ({
    path: "/api/v1/local-runs",
    body: {
      clientRunId: `localrun_${hex(32)}`,
      benchmarkId: w.activeBenchmark,
      benchmarkVersion: w.versions[w.activeBenchmark],
      repositoryId: null,
      repositoryFullName: w.repoA,
      sha: ZERO_SHA,
      branch: "main",
      dirty: false,
    },
  }),
  "POST /api/v1/local-runs/:id/events": (w) => ({
    path: `/api/v1/local-runs/${w.ids.localRunA}/events`,
    body: { eventId: "rj-matrix-event", sequence: 0, occurredAt: 1_790_000_000_000, type: "progress", phase: "preparing" },
  }),
  "POST /api/v1/local-runs/:id/events/batch": (w) => ({
    path: `/api/v1/local-runs/${w.ids.localRunA}/events/batch`,
    body: { events: [{ eventId: "rj-matrix-event", sequence: 0, occurredAt: 1_790_000_000_000, type: "progress", phase: "preparing" }] },
  }),
  "POST /api/internal/v1/runner/events": () => ({ path: "/api/internal/v1/runner/events", body: { runId: "run_rj_missing" } }),
  "GET /api/run-surfaces": () => ({ path: "/api/run-surfaces" }),
  "GET /api/run-surfaces/:id": (w) => ({ path: `/api/run-surfaces/${w.ids.surfaceA}` }),
  "POST /api/run-surfaces/:id/actions/:action": (w) => ({ path: `/api/run-surfaces/${w.ids.surfaceA}/actions/rj_not_an_action` }),
  "GET /api/run-surfaces/:id/stream": (w) => ({ path: `/api/run-surfaces/${w.ids.surfaceA}/stream` }),
  "GET /api/admin/overview": () => ({ path: "/api/admin/overview" }),
  "PATCH /api/admin/cohort": () => ({ path: "/api/admin/cohort", body: { active: true } }),
  "PATCH /api/admin/teams/:teamId": (w) => ({ path: `/api/admin/teams/${w.ids.teamA}`, body: { name: "Demo Team" } }),
  "POST /api/admin/teams/:teamId/members": (w) => ({ path: `/api/admin/teams/${w.ids.teamA}/members`, body: { login: "rj-m-nobody" } }),
  "DELETE /api/admin/teams/:teamId/members/:login": (w) => ({ method: "DELETE", path: `/api/admin/teams/${w.ids.teamA}/members/rj-m-nobody` }),
  "POST /api/admin/teams/:teamId/tas": (w) => ({ path: `/api/admin/teams/${w.ids.teamA}/tas`, body: { login: "rj-m-nobody" } }),
  "DELETE /api/admin/teams/:teamId/tas/:login": (w) => ({ method: "DELETE", path: `/api/admin/teams/${w.ids.teamA}/tas/rj-m-nobody` }),
  "GET /api/admin/staff": () => ({ path: "/api/admin/staff" }),
  "POST /api/admin/staff": () => ({ path: "/api/admin/staff", body: { login: "rj-m-new-staff" } }),
  "DELETE /api/admin/staff/:login": () => ({ method: "DELETE", path: "/api/admin/staff/rj-m-nobody" }),
  "GET /api/admin/desk/teams": () => ({ path: "/api/admin/desk/teams" }),
  "GET /api/admin/desk/teams/:teamId": (w) => ({ path: `/api/admin/desk/teams/${w.ids.teamA}` }),
  "GET /api/admin/desk/teams/:teamId/runs": (w) => ({ path: `/api/admin/desk/teams/${w.ids.teamA}/runs` }),
  "GET /api/activity/oauth/state": () => ({ base: ACTIVITY, path: "/api/activity/oauth/state" }),
  "POST /api/activity/oauth/token": () => ({ base: ACTIVITY, path: "/api/activity/oauth/token", body: { code: "rj-m-unminted", state: "s".repeat(40) } }),
  "GET /api/activity/session": () => ({ base: ACTIVITY, path: "/api/activity/session" }),
  "GET /api/activity/run-surfaces": () => ({ base: ACTIVITY, path: "/api/activity/run-surfaces" }),
  "POST /api/activity/run-surfaces/:id/actions/:action": (w) => ({ base: ACTIVITY, path: `/api/activity/run-surfaces/${w.ids.surfaceA}/actions/rj_not_an_action` }),
  "GET /api/activity/run-surfaces/:id/stream": (w) => ({ base: ACTIVITY, path: `/api/activity/run-surfaces/${w.ids.surfaceA}/stream` }),
  "GET /api/v1/setup/state": () => ({ path: "/api/v1/setup/state" }),
  "POST /api/v1/setup/check-off": () => ({ path: "/api/v1/setup/check-off?t=rj-not-a-token" }),
  "POST /api/v1/cli/setup/checks": (w) => ({
    path: "/api/v1/cli/setup/checks",
    body: { schemaVersion: 1, repositoryFullName: w.repoA, checks: ["clone"], cliVersion: "0.2.0", pythonVersion: "3.8.20", benchmarkIds: [], submissionIds: [] },
  }),
  "DELETE /api/v1/setup/state": null, // LAST: it clears the caller's setup checks
};

/** Routes whose request changes the caller's own standing; sent after every other cell. */
const LAST = {
  "DELETE /api/v1/setup/state": () => ({ method: "DELETE", path: "/api/v1/setup/state" }),
  "DELETE /api/v1/connections/discord": () => ({ method: "DELETE", path: "/api/v1/connections/discord" }),
  "POST /api/session/logout": () => ({ path: "/api/session/logout" }),
};

/**
 * Mutating requests that must still meet authorization first. Each route
 * that changes state gets a malformed request (a body or action the route
 * can't accept, aimed at team A's real resources) and, where the main
 * request names nothing that exists, a valid one aimed at team A's real
 * resources. Every identity the policy refuses for the main request must
 * get exactly the same refusal for these: a validation error or a "not
 * found" first would tell an outsider the request reached further than
 * their identity allows. A malformed request from an identity the guard
 * admits must be a 4xx, never a 5xx. A valid request is sent only to
 * identities the policy refuses (it would really act for the others),
 * unless `to` names who sends it and that they must get their main answer.
 * The run's D1 is compared before and after every one of these: none may
 * change anything.
 */
const ACTIONS = ["verify_hosted", "promote_official", "publish_result", "rerun_hosted"];
/** `missing`: the same request naming a thing that doesn't exist, for the "resource" refusals below. */
const malformed = (label, request, missing) => ({ kind: "malformed", label, request, missing });
const weightsWithoutChecksum = (reportId) => ({
  method: "PUT",
  path: `/api/v1/local-reports/${reportId}/weights/model.npz`,
  body: "x",
  headers: { "content-type": "application/octet-stream" },
});
const valid = (label, request, extra = {}) => ({ kind: "valid", label, request, ...extra });

const VARIANTS = {
  "POST /api/cohorts/join": [malformed("a code that isn't text", () => ({ path: "/api/cohorts/join", body: { code: 42 } }))],
  "POST /api/github/connect": [malformed("a repository that isn't text", () => ({ path: "/api/github/connect", body: { fullName: 42 } }))],
  "POST /api/github/webhook": [
    malformed("an unsigned body that isn't JSON", () => ({ path: "/api/github/webhook", body: "{not json", headers: { "content-type": "application/json", "x-github-event": "push" } })),
  ],
  "POST /api/runs/practice": [
    malformed("team A with a benchmark that isn't text", (w) => ({ path: "/api/runs/practice", body: { teamId: w.ids.teamA, benchmarkId: 42 } })),
    valid("a practice run for team A", (w) => ({ path: "/api/runs/practice", body: { teamId: w.ids.teamA, benchmarkId: w.activeBenchmark } })),
  ],
  "POST /api/runs/:id/promote": [valid("promote team A's run", (w) => ({ path: `/api/runs/${w.ids.runA}/promote` }))],
  "PUT /api/leaderboard-selection": [
    malformed("a run id that isn't text", () => ({ method: "PUT", path: "/api/leaderboard-selection", body: { runId: 42 } })),
    valid("select team A's run", (w) => ({ method: "PUT", path: "/api/leaderboard-selection", body: { runId: w.ids.runA } })),
  ],
  "PATCH /api/team": [
    malformed("team A with a name that isn't text", (w) => ({ path: "/api/team", body: { teamId: w.ids.teamA, name: 42 } })),
    valid("rename team A", (w) => ({ path: "/api/team", body: { teamId: w.ids.teamA, name: "RJ Hijacked Name" } })),
  ],
  "POST /api/team/repository": [
    malformed("team A with a repository that isn't text", (w) => ({ path: "/api/team/repository", body: { teamId: w.ids.teamA, fullName: 42 } })),
  ],
  "POST /api/team/join": [
    malformed("a team id that isn't text", () => ({ path: "/api/team/join", body: { teamId: 42 } })),
    valid("join team A", (w) => ({ path: "/api/team/join", body: { teamId: w.ids.teamA } })),
  ],
  "POST /api/team/leave": [malformed("a team id that isn't text", () => ({ path: "/api/team/leave", body: { teamId: 42 } }))],
  "POST /api/team/members": [
    malformed("team A with a login that isn't text", (w) => ({ path: "/api/team/members", body: { teamId: w.ids.teamA, login: 42 } })),
  ],
  "DELETE /api/team/members/:login": [
    malformed("team A, a login past any length", (w) => ({ method: "DELETE", path: `/api/team/members/${"x".repeat(300)}?teamId=${w.ids.teamA}` })),
    valid("remove team A's member", (w) => ({ method: "DELETE", path: `/api/team/members/rj-m-teammate-a?teamId=${w.ids.teamA}` })),
  ],
  "POST /api/v1/connections/discord/preview": [malformed("a token that isn't text", () => ({ path: "/api/v1/connections/discord/preview", body: { token: 42 } }))],
  "POST /api/v1/connections/discord/confirm": [malformed("a token that isn't text", () => ({ path: "/api/v1/connections/discord/confirm", body: { token: 42 } }))],
  "POST /api/v1/cli/device/approve": [malformed("a user code that isn't text", () => ({ path: "/api/v1/cli/device/approve", body: { userCode: 42 } }))],
  "DELETE /api/v1/cli/devices": [
    malformed("a device id that isn't text", () => ({ method: "DELETE", path: "/api/v1/cli/devices", body: { deviceId: 42 } })),
    // Revoking is scoped to the caller's own devices: anyone else asking
    // to revoke student A's gets the same no-op answer as for a device
    // that doesn't exist, and the device stays live.
    valid("revoke student A's live device", (w) => ({ method: "DELETE", path: "/api/v1/cli/devices", body: { deviceId: w.ids.deviceA } }), {
      to: ["joiner", "outsider", "teammateA", "studentB", "changedTeam", "taAssigned", "taUnassigned", "owner"],
    }),
  ],
  "POST /api/v1/local-reports": [malformed("a body that isn't JSON", () => ({ path: "/api/v1/local-reports", body: "{not json" }))],
  "PUT /api/v1/local-reports/:reportId/weights/*": [
    malformed(
      "team A's report, no checksum",
      () => weightsWithoutChecksum("rj-canary-report-a"),
      () => weightsWithoutChecksum("rj-matrix-missing"),
    ),
  ],
  "POST /api/v1/local-runs": [malformed("a run id that isn't text", () => ({ path: "/api/v1/local-runs", body: { clientRunId: 42 } }))],
  "POST /api/v1/local-runs/:id/events": [
    malformed(
      "team A's local run, an event that isn't one",
      (w) => ({ path: `/api/v1/local-runs/${w.ids.localRunA}/events`, body: { eventId: 42 } }),
      () => ({ path: "/api/v1/local-runs/localsession_rj_missing/events", body: { eventId: 42 } }),
    ),
  ],
  "POST /api/v1/local-runs/:id/events/batch": [
    malformed(
      "team A's local run, events that aren't a list",
      (w) => ({ path: `/api/v1/local-runs/${w.ids.localRunA}/events/batch`, body: { events: "x" } }),
      () => ({ path: "/api/v1/local-runs/localsession_rj_missing/events/batch", body: { events: "x" } }),
    ),
  ],
  "POST /api/internal/v1/runner/events": [malformed("an unsigned body that isn't JSON", () => ({ path: "/api/internal/v1/runner/events", body: "{not json" }))],
  "POST /api/run-surfaces/:id/actions/:action": [
    ...ACTIONS.map((action) => valid(`${action} on team A's console`, (w) => ({ path: `/api/run-surfaces/${w.ids.surfaceA}/actions/${action}` }))),
    malformed(
      "retry on team A's console with a run id that isn't text",
      (w) => ({ path: `/api/run-surfaces/${w.ids.surfaceA}/actions/retry`, body: { runId: 42 } }),
      () => ({ path: `/api/run-surfaces/surface_${"0".repeat(20)}/actions/retry`, body: { runId: 42 } }),
    ),
  ],
  "PATCH /api/admin/cohort": [
    malformed("active that isn't true or false", () => ({ path: "/api/admin/cohort", body: { active: "yes" } })),
    valid("rotate the join code", () => ({ path: "/api/admin/cohort", body: { rotateJoinCode: true } })),
  ],
  "PATCH /api/admin/teams/:teamId": [
    malformed("team A with a name that isn't text", (w) => ({ path: `/api/admin/teams/${w.ids.teamA}`, body: { name: 42 } })),
    valid("rename team A", (w) => ({ path: `/api/admin/teams/${w.ids.teamA}`, body: { name: "RJ Hijacked Name" } })),
  ],
  "POST /api/admin/teams/:teamId/members": [
    malformed("team A with a login that isn't text", (w) => ({ path: `/api/admin/teams/${w.ids.teamA}/members`, body: { login: 42 } })),
  ],
  "DELETE /api/admin/teams/:teamId/members/:login": [
    valid("remove team A's member", (w) => ({ method: "DELETE", path: `/api/admin/teams/${w.ids.teamA}/members/rj-m-teammate-a` })),
  ],
  "POST /api/admin/teams/:teamId/tas": [
    malformed("team A with a login that isn't text", (w) => ({ path: `/api/admin/teams/${w.ids.teamA}/tas`, body: { login: 42 } })),
  ],
  "DELETE /api/admin/teams/:teamId/tas/:login": [
    valid("unassign team A's TA", (w) => ({ method: "DELETE", path: `/api/admin/teams/${w.ids.teamA}/tas/rj-m-ta-assigned` })),
  ],
  "POST /api/admin/staff": [malformed("a login that isn't text", () => ({ path: "/api/admin/staff", body: { login: 42 } }))],
  "DELETE /api/admin/staff/:login": [valid("remove a staff member", () => ({ method: "DELETE", path: "/api/admin/staff/rj-m-ta-assigned" }))],
  "POST /api/activity/run-surfaces/:id/actions/:action": [
    ...ACTIONS.map((action) => valid(`${action} on team A's console`, (w) => ({ base: ACTIVITY, path: `/api/activity/run-surfaces/${w.ids.surfaceA}/actions/${action}` }))),
    malformed("retry on team A's console with a run id that isn't text", (w) => ({
      base: ACTIVITY,
      path: `/api/activity/run-surfaces/${w.ids.surfaceA}/actions/retry`,
      body: { runId: 42 },
    })),
  ],
  "POST /api/v1/cli/setup/checks": [malformed("a schema version that isn't a number", () => ({ path: "/api/v1/cli/setup/checks", body: { schemaVersion: "one" } }))],
};

/** Mutating routes with no variant, and why. */
const NO_VARIANT = {
  "ALL /api/auth/*": "Better Auth's own handler (worker/auth); the matrix's request reads a session and the portal signs in through /api/dev/login",
  "POST /api/dev/login": "signs anyone in, by design, in development only; there is no caller to authorize",
  "POST /api/session/logout": "ends the caller's own session and takes no body",
  "POST /api/v1/cli/device/start": "starts a device authorization for anyone, by design; there is no caller to authorize",
  "POST /api/v1/cli/device/token": "the device code in the body is the credential",
  "POST /api/activity/oauth/token": "the Discord code and the state cookie are the credential",
  "POST /api/v1/setup/check-off": "the signed token in the query is the credential",
  "DELETE /api/v1/connections/discord": "unlinks the caller's own Discord and takes no body",
  "DELETE /api/v1/setup/state": "clears the caller's own setup checks and takes no body",
};

/**
 * How a main-cell answer refused `identity`, which decides what a variant of
 * the same request must get:
 * - "identity": no session or token (401), a role, team or right the caller
 *   lacks (403), or team A named by someone not on it (409). Settled by who
 *   is asking, so every variant gets exactly this answer.
 * - "resource": another team's thing named in the path, answered as missing
 *   (404). A malformed variant may be refused for its body first, but must
 *   get the answer it gets for a thing that doesn't exist (`missing`), so
 *   nothing tells whether team A's exists.
 * - null: not refused, or refused for what the request said (BODY_DECIDES).
 *   A malformed variant gets a 4xx.
 */
function refusal(key, answer, identity, request, w) {
  const [status, rest = ""] = answer.split(/ (.*)/s);
  if (BODY_DECIDES[key]?.who.includes(identity)) return null;
  if (status === "401" || status === "403") return "identity";
  if (rest.includes("not the team this page showed")) {
    const namesTeamA = JSON.stringify([request.path, request.body]).includes(w.ids.teamA);
    return namesTeamA && !TEAM_A.includes(identity) ? "identity" : null;
  }
  if (status === "404" && OTHER_TEAM.includes(identity)) return "resource";
  return null;
}

/** Refusals in the main cells that the request's content decides, not the caller. */
const BODY_DECIDES = {
  "POST /api/cohorts/join": {
    who: ["joiner", "outsider", "studentA", "teammateA", "studentB", "changedTeam", "taAssigned", "taUnassigned", "owner"],
    why: "the join code is the credential: 403 cohort_code_invalid says the code sent was wrong",
  },
  "POST /api/github/connect": {
    who: ["outsider"],
    why: "the repository named decides whether GitHub sign-in is needed (the fixture repository needs none)",
  },
};
const OTHER_TEAM = ["studentB", "changedTeam", "deviceB"];

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const RUNNER_SECRET = "rj-local-runner-signing-secret-0001";
const WEBHOOK_SECRET = "rj-local-github-webhook-secret";

/** The runner's request signature (worker/execution/runner.ts hmacSignature). */
function runnerHeaders(signed) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", RUNNER_SECRET).update(`${timestamp}.${signed}`).digest("hex");
  return { "x-cogworks-key-id": "runner-v1", "x-cogworks-timestamp": timestamp, "x-cogworks-signature": `v1=${signature}` };
}

/** Opens a WebSocket with a caller's cookie and resolves with its first message. */
function firstMessage(url, cookie) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie, origin: new URL(url.replace(/^ws/, "http")).origin } });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`no message on ${url}`));
    }, 15_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      socket.close();
      resolve(JSON.parse(String(event.data)));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error on ${url}`));
    });
  });
}

const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`;
/** Dev accounts carry no GitHub login; the routes that find people by one need it set. */
const giveGithubLogin = (login) => control.sql(`UPDATE users SET github_login = ${sqlText(login)} WHERE email = ${sqlText(`${login}@dev.local`)}`);

/**
 * Positive controls: for each route, a request a caller the policy allows
 * makes for real, and the status it must get. They run after every cell and
 * before the LAST cells, in this order (later ones use what earlier ones
 * made). Throwaway accounts stand in where a success would change an
 * identity the cells use.
 */
const POSITIVE = [
  ["ALL /api/auth/*", 200, (w) => call("GET", "/api/auth/get-session", { who: w.who.studentA })],
  ["GET /api/session", 200, (w) => call("GET", "/api/session", { who: w.who.studentA })],
  ["POST /api/dev/login", 200, () => call("POST", "/api/dev/login", { body: { login: "rj-m-positive" } })],
  ["POST /api/cohorts/join", 200, async () => call("POST", "/api/cohorts/join", { who: await devLogin("rj-m-pos-joiner"), body: { code: "VISION26" } })],
  ["GET /api/github/repositories", 200, (w) => call("GET", "/api/github/repositories", { who: w.who.studentA })],
  ["POST /api/github/connect", 200, async () => {
    const who = await devLogin("rj-m-pos-connect");
    await call("POST", "/api/cohorts/join", { who, body: { code: "VISION26" } });
    return call("POST", "/api/github/connect", { who, body: { fullName: "cogworks-demo/face-finder" } });
  }],
  ["POST /api/github/webhook", 200, () => {
    const body = JSON.stringify({ zen: "rj ping", hook_id: 1 });
    const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    return call("POST", "/api/github/webhook", { body, headers: { "content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": `sha256=${signature}` } });
  }],
  ["GET /api/runs", 200, (w) => call("GET", "/api/runs", { who: w.who.studentA })],
  ["GET /api/runs/:id", 200, (w) => call("GET", `/api/runs/${w.ids.runA}`, { who: w.who.studentA })],
  ["GET /api/dashboard", 200, (w) => call("GET", "/api/dashboard", { who: w.who.studentA })],
  ["POST /api/runs/:id/promote", 201, async (w) => {
    const result = await call("POST", `/api/runs/${w.ids.runA}/promote`, { who: w.who.studentA });
    w.ids.officialA = result.json?.runId;
    return result;
  }],
  ["PUT /api/leaderboard-selection", 200, async (w) => {
    for (let i = 0; i < 90; i += 1) {
      const run = (await call("GET", `/api/runs/${w.ids.officialA}`, { who: w.who.studentA })).json;
      if (run?.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return call("PUT", "/api/leaderboard-selection", { who: w.who.studentA, body: { runId: w.ids.officialA } });
  }],
  ["POST /api/run-surfaces/:id/actions/:action", 200, async (w) => {
    const run = (await call("GET", `/api/runs/${w.ids.officialA}`, { who: w.who.studentA })).json;
    w.ids.officialSurface = run.surfaceId;
    return call("POST", `/api/run-surfaces/${run.surfaceId}/actions/publish_result`, { who: w.who.studentA });
  }],
  ["POST /api/runs/practice", 201, async (w) => {
    const result = await call("POST", "/api/runs/practice", { who: w.who.studentA, body: { teamId: w.ids.teamA, benchmarkId: w.activeBenchmark } });
    // Runs go one at a time per benchmark; let it finish before the
    // Activity's rerun below starts another.
    for (let i = 0; result.status === 201 && i < 90; i += 1) {
      const run = (await call("GET", `/api/runs/${result.json.runId}`, { who: w.who.studentA })).json;
      if (run?.status === "succeeded" || run?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return result;
  }],
  ["GET /api/leaderboard", 200, () => call("GET", "/api/leaderboard")],
  ["GET /api/v1/leaderboard", 200, () => call("GET", "/api/v1/leaderboard")],
  ["GET /api/leaderboard-family", 200, () => call("GET", "/api/leaderboard-family")],
  ["GET /api/benchmarks", 200, () => call("GET", "/api/benchmarks")],
  ["GET /api/v1/benchmarks", 200, () => call("GET", "/api/v1/benchmarks")],
  ["GET /api/team", 200, (w) => call("GET", "/api/team", { who: w.who.studentA })],
  ["GET /api/v1/team/process", 200, (w) => call("GET", "/api/v1/team/process", { who: w.who.studentA })],
  ["PATCH /api/team", 200, (w) => call("PATCH", "/api/team", { who: w.who.studentA, body: { teamId: w.ids.teamA, description: "Matrix positive control." } })],
  ["POST /api/team/repository", 200, (w) => call("POST", "/api/team/repository", { who: w.who.studentA, body: { teamId: w.ids.teamA, fullName: w.repoA } })],
  ["GET /api/cohorts/teams", 200, (w) => call("GET", "/api/cohorts/teams", { who: w.who.studentA })],
  ["POST /api/team/join", 200, async (w) => {
    const who = await devLogin("rj-m-pos-team-joiner");
    await call("POST", "/api/cohorts/join", { who, body: { code: "VISION26" } });
    return call("POST", "/api/team/join", { who, body: { teamId: w.ids.teamA } });
  }],
  ["POST /api/team/leave", 200, async (w) => call("POST", "/api/team/leave", { who: await devLogin("rj-m-pos-leaver", { demo: true }), body: { teamId: w.ids.teamA } })],
  ["GET /api/team/invitable", 200, (w) => call("GET", "/api/team/invitable", { who: w.who.studentA })],
  ["POST /api/team/members", 200, async (w) => {
    const who = await devLogin("rj-m-pos-invitee");
    await call("POST", "/api/cohorts/join", { who, body: { code: "VISION26" } });
    await giveGithubLogin("rj-m-pos-invitee");
    return call("POST", "/api/team/members", { who: w.who.studentA, body: { teamId: w.ids.teamA, login: "rj-m-pos-invitee" } });
  }],
  ["DELETE /api/team/members/:login", 200, (w) => call("DELETE", `/api/team/members/rj-m-pos-invitee?teamId=${w.ids.teamA}`, { who: w.who.studentA })],
  ["GET /api/v1/connections", 200, (w) => call("GET", "/api/v1/connections", { who: w.who.studentA })],
  ["POST /api/v1/connections/discord/preview", 200, async (w) => {
    const activity = await activitySession({ id: "900000000000000299", username: "rj-m-pos-discord" }, "rj-m-pos-code");
    const session = (await call("GET", "/api/activity/session", { who: activity, base: ACTIVITY })).json;
    w.ids.linkToken = new URL(session.linkUrl).hash.replace("#discord=", "");
    w.who.positiveLinker = await devLogin("rj-m-pos-linker", { demo: true });
    return call("POST", "/api/v1/connections/discord/preview", { who: w.who.positiveLinker, body: { token: w.ids.linkToken } });
  }],
  ["POST /api/v1/connections/discord/confirm", 200, (w) => call("POST", "/api/v1/connections/discord/confirm", { who: w.who.positiveLinker, body: { token: w.ids.linkToken } })],
  ["POST /api/v1/cli/device/start", 200, async (w) => {
    const result = await call("POST", "/api/v1/cli/device/start");
    w.ids.deviceStart = result.json;
    return result;
  }],
  ["POST /api/v1/cli/device/approve", 200, (w) => call("POST", "/api/v1/cli/device/approve", { who: w.who.studentA, body: { userCode: w.ids.deviceStart.userCode, deviceName: "rj-m-pos-device" } })],
  ["POST /api/v1/cli/device/token", 200, async (w) => {
    const result = await call("POST", "/api/v1/cli/device/token", { body: { deviceCode: w.ids.deviceStart.deviceCode } });
    w.who.positiveDevice = { bearer: result.json?.token };
    return result;
  }],
  ["DELETE /api/v1/cli/devices", 200, async (w) => {
    const [{ id }] = await control.sql("SELECT id FROM cli_devices WHERE name = 'rj-m-pos-device'");
    return call("DELETE", "/api/v1/cli/devices", { who: w.who.studentA, body: { deviceId: id } });
  }],
  ["GET /api/v1/cli/device/status", 200, (w) => call("GET", "/api/v1/cli/device/status", { who: w.who.deviceA })],
  ["POST /api/v1/local-reports", 201, (w) => {
    const bytes = "rj matrix weights";
    w.ids.weight = { bytes, sha256: sha256(bytes) };
    return call("POST", "/api/v1/local-reports", {
      who: w.who.deviceA,
      body: { ...report(w, "rj-matrix-report-weights"), weightsUsed: ["model.npz"], weightsUploaded: [{ path: "model.npz", sha256: w.ids.weight.sha256 }] },
    });
  }],
  ["PUT /api/v1/local-reports/:reportId/weights/*", 201, (w) =>
    call("PUT", "/api/v1/local-reports/rj-matrix-report-weights/weights/model.npz", {
      who: w.who.deviceA,
      body: w.ids.weight.bytes,
      headers: { "content-type": "application/octet-stream", "x-cogworks-weight-sha256": w.ids.weight.sha256 },
    })],
  ["GET /api/v1/local-reports", 200, (w) => call("GET", "/api/v1/local-reports", { who: w.who.studentA })],
  ["POST /api/v1/local-runs", 201, (w) => {
    // A run id of its own: the cells already started the matrix's one, so
    // sending that again is a replay (200), not a start.
    const request = REQUESTS["POST /api/v1/local-runs"](w);
    return call("POST", request.path, { who: w.who.deviceA, body: { ...request.body, clientRunId: `localrun_${"d".repeat(32)}` } });
  }],
  ["POST /api/v1/local-runs/:id/events", 200, (w) => call("POST", `/api/v1/local-runs/${w.ids.localRunA}/events`, {
    who: w.who.deviceA,
    body: { eventId: "rj-matrix-event-2", sequence: 1, occurredAt: 1_790_000_000_100, type: "progress", phase: "evaluating" },
  })],
  ["POST /api/v1/local-runs/:id/events/batch", 200, (w) => call("POST", `/api/v1/local-runs/${w.ids.localRunA}/events/batch`, {
    who: w.who.deviceA,
    body: { events: [{ eventId: "rj-matrix-event-3", sequence: 2, occurredAt: 1_790_000_000_200, type: "progress", phase: "scoring" }] },
  })],
  ["POST /api/internal/v1/runner/events", 200, (w) => {
    const body = JSON.stringify({ protocolVersion: "1", eventId: "rj-matrix-runner-1", runId: w.ids.runA, sequence: 0, occurredAt: Date.now(), type: "status", status: "preparing" });
    return call("POST", "/api/internal/v1/runner/events", { body, headers: { "content-type": "application/json", ...runnerHeaders(body) } });
  }],
  ["GET /api/run-surfaces", 200, (w) => call("GET", "/api/run-surfaces", { who: w.who.studentA })],
  ["GET /api/run-surfaces/:id", 200, (w) => call("GET", `/api/run-surfaces/${w.ids.surfaceA}`, { who: w.who.studentA })],
  ["GET /api/run-surfaces/:id/stream", 101, async (w) => {
    const message = await firstMessage(`ws://127.0.0.1:8810/api/run-surfaces/${w.ids.surfaceA}/stream`, w.who.studentA.cookie);
    return { status: message ? 101 : 0, json: message, text: JSON.stringify(message).slice(0, 200) };
  }],
  ["GET /api/admin/overview", 200, (w) => call("GET", "/api/admin/overview", { who: w.who.owner })],
  ["PATCH /api/admin/cohort", 200, (w) => call("PATCH", "/api/admin/cohort", { who: w.who.owner, body: { active: true } })],
  ["PATCH /api/admin/teams/:teamId", 200, (w) => call("PATCH", `/api/admin/teams/${w.ids.teamA}`, { who: w.who.taAssigned, body: { description: "Staff note from the matrix." } })],
  ["POST /api/admin/teams/:teamId/members", 200, async (w) => {
    const who = await devLogin("rj-m-pos-admin-add");
    await call("POST", "/api/cohorts/join", { who, body: { code: "VISION26" } });
    await giveGithubLogin("rj-m-pos-admin-add");
    return call("POST", `/api/admin/teams/${w.ids.teamA}/members`, { who: w.who.owner, body: { login: "rj-m-pos-admin-add" } });
  }],
  ["DELETE /api/admin/teams/:teamId/members/:login", 200, (w) => call("DELETE", `/api/admin/teams/${w.ids.teamA}/members/rj-m-pos-admin-add`, { who: w.who.owner })],
  ["POST /api/admin/teams/:teamId/tas", 200, async (w) => {
    await devLogin("rj-m-pos-ta");
    await giveGithubLogin("rj-m-pos-ta");
    return call("POST", `/api/admin/teams/${w.ids.teamA}/tas`, { who: w.who.owner, body: { login: "rj-m-pos-ta" } });
  }],
  ["DELETE /api/admin/teams/:teamId/tas/:login", 200, (w) => call("DELETE", `/api/admin/teams/${w.ids.teamA}/tas/rj-m-pos-ta`, { who: w.who.owner })],
  ["GET /api/admin/staff", 200, (w) => call("GET", "/api/admin/staff", { who: w.who.owner })],
  ["POST /api/admin/staff", 200, (w) => call("POST", "/api/admin/staff", { who: w.who.owner, body: { login: "rj-m-pos-staff" } })],
  ["DELETE /api/admin/staff/:login", 200, (w) => call("DELETE", "/api/admin/staff/rj-m-pos-staff", { who: w.who.owner })],
  ["GET /api/admin/desk/teams", 200, (w) => call("GET", "/api/admin/desk/teams", { who: w.who.taAssigned })],
  ["GET /api/admin/desk/teams/:teamId", 200, (w) => call("GET", `/api/admin/desk/teams/${w.ids.teamA}`, { who: w.who.taAssigned })],
  ["GET /api/admin/desk/teams/:teamId/runs", 200, (w) => call("GET", `/api/admin/desk/teams/${w.ids.teamA}/runs`, { who: w.who.taAssigned })],
  ["GET /api/activity/oauth/state", 200, () => call("GET", "/api/activity/oauth/state", { base: ACTIVITY })],
  ["POST /api/activity/oauth/token", 200, async () => {
    // activitySession runs the exchange and throws unless it answers 2xx.
    await activitySession({ id: "900000000000000298", username: "rj-m-pos-exchange" }, "rj-m-pos-exchange-code");
    return { status: 200 };
  }],
  ["GET /api/activity/session", 200, (w) => call("GET", "/api/activity/session", { who: w.who.activityA, base: ACTIVITY })],
  ["GET /api/activity/run-surfaces", 200, (w) => call("GET", "/api/activity/run-surfaces", { who: w.who.activityA, base: ACTIVITY })],
  ["POST /api/activity/run-surfaces/:id/actions/:action", 200, (w) =>
    call("POST", `/api/activity/run-surfaces/${w.ids.surfaceA}/actions/rerun_hosted`, { who: w.who.activityA, base: ACTIVITY })],
  ["GET /api/activity/run-surfaces/:id/stream", 101, async (w) => {
    const message = await firstMessage(`ws://localhost:8810/api/activity/run-surfaces/${w.ids.surfaceA}/stream`, w.who.activityA.cookie);
    return { status: message ? 101 : 0, json: message, text: JSON.stringify(message).slice(0, 200) };
  }],
  ["GET /api/v1/setup/state", 200, (w) => call("GET", "/api/v1/setup/state", { who: w.who.studentA })],
  ["POST /api/v1/setup/check-off", 200, async (w) => {
    const state = (await call("GET", `/api/v1/setup/state?benchmarkId=${w.activeBenchmark}`, { who: w.who.studentA })).json;
    const [token] = Object.values(state.tokens ?? {});
    return call("POST", `/api/v1/setup/check-off?t=${encodeURIComponent(token)}`);
  }],
  ["POST /api/v1/cli/setup/checks", 200, (w) => send(w, "POST /api/v1/cli/setup/checks", REQUESTS["POST /api/v1/cli/setup/checks"], w.who.deviceA)],
  ["DELETE /api/v1/setup/state", 200, async () => call("DELETE", "/api/v1/setup/state", { who: await devLogin("second-owner", { demo: true }) })],
  ["DELETE /api/v1/connections/discord", 200, (w) => call("DELETE", "/api/v1/connections/discord", { who: w.who.positiveLinker })],
  ["POST /api/session/logout", 200, async () => call("POST", "/api/session/logout", { who: await devLogin("rj-m-pos-logout") })],
];

function describe(result) {
  const error = result.json?.error;
  if (error && typeof error === "object") return `${result.status} ${error.code}: ${error.message}`;
  if (result.status >= 400 && result.text && !result.json) return `${result.status} text: ${result.text.slice(0, 160)}`;
  return `${result.status}`;
}

async function send(w, key, spec, who) {
  const request = spec(w);
  const method = request.method ?? key.split(" ")[0];
  return call(method === "ALL" ? "GET" : method, request.path, { who, body: request.body, base: request.base ?? STACK, headers: request.headers });
}

test("every Worker route answers every identity exactly as the policy says", async ({}, testInfo) => {
  test.setTimeout(900_000);
  const mode = matrixMode(testInfo);
  const registered = workerRoutes();
  const covered = Object.keys(REQUESTS);
  expect(covered.filter((key) => !registered.includes(key)), "requests for routes the Worker no longer registers").toEqual([]);
  expect(registered.filter((key) => !covered.includes(key)), "registered routes with no request in the matrix").toEqual([]);
  const mutating = registered.filter((key) => !/^GET /.test(key));
  expect(mutating.filter((key) => !VARIANTS[key] && !NO_VARIANT[key]), "mutating routes with no variant and no stated reason").toEqual([]);
  if (mode === "enforce") {
    expect(Object.keys(POLICY).sort(), "policy rows").toEqual([...registered].sort());
    const succeeds = (key) => Object.keys(POLICY[key]).some((answer) => /^20[01]$/.test(answer));
    expect(registered.filter((key) => succeeds(key) && !CONTENT[key]), "routes that answer 2xx with no content check").toEqual([]);
  }

  await fresh();
  const world = await buildWorld();
  const w = { ...world, ...(await worldFacts(world)) };
  const canaries = await plantCanaries(w, { staffWithFullView: ["taAssigned", "owner"] });

  const observed = {};
  const answers = {};
  const cells = [];
  const record = (key, identity, result) => {
    observed[key] ??= {};
    const answer = describe(result);
    (observed[key][answer] ??= []).push(identity);
    (answers[key] ??= {})[identity] = answer;
    cells.push({ key, identity, result });
  };
  for (const key of registered) {
    const spec = REQUESTS[key];
    if (!spec) continue;
    for (const identity of IDENTITIES) record(key, identity, await send(w, key, spec, world.who[identity]));
  }

  // Malformed and valid mutations, bracketed by two reads of the whole D1.
  const before = await control.snapshot();
  const variantMismatches = [];
  for (const [key, variants] of Object.entries(VARIANTS)) {
    for (const variant of variants) {
      const request = variant.request(w);
      const kind = Object.fromEntries(IDENTITIES.map((identity) => [identity, refusal(key, answers[key][identity], identity, request, w)]));
      const to = variant.to ?? (variant.kind === "valid" ? IDENTITIES.filter((identity) => kind[identity]) : IDENTITIES);
      for (const identity of to) {
        const result = await send(w, key, () => request, world.who[identity]);
        cells.push({ key: `${key} [${variant.label}]`, identity, result, variant: true });
        const got = describe(result);
        let want = null;
        if (variant.to || variant.kind === "valid" || kind[identity] === "identity") want = answers[key][identity];
        else if (kind[identity] === "resource") {
          if (!variant.missing) throw new Error(`${key} [${variant.label}] needs a missing-resource twin for ${identity}`);
          want = describe(await send(w, key, variant.missing, world.who[identity]));
        }
        const wrong = want === null ? !(result.status >= 400 && result.status < 500) : got !== want;
        if (wrong) variantMismatches.push({ route: key, variant: variant.label, identity, want: want ?? "a 4xx", got });
      }
    }
  }
  const changed = changedRows(before, await control.snapshot());

  const positives = {};
  for (const [key, status, run] of POSITIVE) {
    let result;
    try {
      result = await run(w);
    } catch (error) {
      result = { status: 0, text: String(error.message ?? error) };
    }
    positives[key] = { want: status, got: result.status, answer: result.status === status ? undefined : (result.text ?? "").slice(0, 300) };
  }
  for (const [key, spec] of Object.entries(LAST)) {
    for (const identity of IDENTITIES) record(key, identity, await send(w, key, spec, world.who[identity]));
  }

  // What each 2xx answer is about, and private data in any answer.
  const facts = contentFacts(w, await control.snapshot());
  const wrongContent = [];
  const leaked = [];
  for (const { key, identity, result, variant } of cells) {
    if (!variant && (result.status === 200 || result.status === 201) && CONTENT[key]) {
      const problem = CONTENT[key](result.json, identity, facts);
      if (problem) wrongContent.push({ route: key, identity, problem });
    }
    const found = leaks(result.text, identity, canaries);
    if (found.length) leaked.push({ route: key, identity, status: result.status, found });
  }
  // The planted per-person work is there to be withheld: staff with the full
  // view do read it, so its absence elsewhere means something.
  const deskA = cells.find((c) => c.key === "GET /api/admin/desk/teams/:teamId" && c.identity === "taAssigned");
  if (!deskA?.result.text.includes("rj-canary-a-author-one")) wrongContent.push({ route: deskA?.key, identity: "taAssigned", problem: "the assigned TA's desk doesn't show team A's per-person work" });

  const out = path.join("test-results", "evidence", "route-matrix-observed.json");
  fs.writeFileSync(out, `${JSON.stringify(observed, null, 2)}\n`);
  fs.writeFileSync(path.join("test-results", "evidence", "route-matrix-positive.json"), `${JSON.stringify(positives, null, 2)}\n`);
  fs.writeFileSync(
    path.join("test-results", "evidence", "route-matrix-content.json"),
    `${JSON.stringify({ wrongContent, leaked, variantMismatches, changed, canaries: canaries.map(({ name, allowed }) => ({ name, allowed })) }, null, 2)}\n`,
  );
  if (mode === "observe") failObserved(out);

  const mismatches = [];
  for (const key of registered) {
    const want = normalise(POLICY[key]);
    const got = normalise(observed[key]);
    if (JSON.stringify(want) !== JSON.stringify(got)) mismatches.push({ route: key, want, got });
  }
  for (const key of registered) {
    const positive = positives[key];
    if (!positive && !NO_POSITIVE[key]) mismatches.push({ route: key, problem: "no positive control and no stated reason" });
    if (positive && positive.got !== positive.want) mismatches.push({ route: key, positive });
  }
  expect(mismatches, `cells that differ from the policy (full table: ${out})`).toEqual([]);
  expect(leaked, "answers carrying private data their caller may not read").toEqual([]);
  expect(wrongContent, "successful answers about the wrong subject").toEqual([]);
  expect(variantMismatches, "malformed or valid mutations not refused exactly as the main request").toEqual([]);
  expect(changed, "D1 rows the refused mutations changed").toEqual([]);
  await expectNoDispatch();
});

// Under STAFF_VISIBILITY=restricted a TA reads team-level facts only. Every
// staff route a TA can reach is called by both TAs and the owner in a world
// with team A's per-person work planted: the TAs' answers name no student and
// carry none of it; the owner's carry both, so the withheld data is there to
// withhold.
test("under the restricted staff setting, staff answers carry no student's name or per-person work", async ({}, testInfo) => {
  test.setTimeout(600_000);
  matrixMode(testInfo);
  await fresh("fixture-restricted");
  const world = await buildWorld();
  const w = { ...world, ...(await worldFacts(world)) };
  const canaries = await plantCanaries(w, { staffWithFullView: ["owner"] });
  const routes = {
    "GET /api/admin/overview": () => ({ path: "/api/admin/overview" }),
    "GET /api/admin/desk/teams": () => ({ path: "/api/admin/desk/teams" }),
    "GET /api/admin/desk/teams/:teamId": (v) => ({ path: `/api/admin/desk/teams/${v.ids.teamA}` }),
    "GET /api/admin/desk/teams/:teamId/runs": (v) => ({ path: `/api/admin/desk/teams/${v.ids.teamA}/runs` }),
    "PATCH /api/admin/teams/:teamId": (v) => ({ path: `/api/admin/teams/${v.ids.teamA}`, body: { description: "Staff note under the restricted setting." } }),
    "POST /api/admin/teams/:teamId/members": (v) => ({ path: `/api/admin/teams/${v.ids.teamA}/members`, body: { login: "rj-m-nobody" } }),
  };
  const students = [LOGINS.studentA, LOGINS.teammateA];
  const problems = [];
  const answers = {};
  for (const [key, spec] of Object.entries(routes)) {
    for (const identity of ["taAssigned", "taUnassigned", "owner"]) {
      const result = await send(w, key, spec, world.who[identity]);
      (answers[key] ??= {})[identity] = describe(result);
      const found = leaks(result.text, identity, canaries);
      if (found.length) problems.push({ route: key, identity, leaked: found });
      const named = identity === "owner" ? [] : students.filter((login) => result.text.includes(login));
      if (named.length) problems.push({ route: key, identity, named });
    }
  }
  fs.writeFileSync(path.join("test-results", "evidence", "route-matrix-restricted.json"), `${JSON.stringify({ answers, problems }, null, 2)}\n`);
  expect(problems, "staff answers under the restricted setting that name students or carry their work").toEqual([]);

  const desk = (await call("GET", `/api/admin/desk/teams/${w.ids.teamA}`, { who: world.who.taAssigned })).json;
  expect({ view: desk.view, members: desk.team.members, commitSignals: desk.commitSignals }).toEqual({ view: "restricted", members: [], commitSignals: null });
  const overview = (await call("GET", "/api/admin/overview", { who: world.who.taAssigned })).json;
  expect(overview.teams.map((team) => ({ id: team.id, members: team.members, published: team.published }))).toEqual([
    { id: w.ids.teamA, members: [], published: null },
  ]);
  expect(answers["POST /api/admin/teams/:teamId/members"].taAssigned).toBe(
    "403 forbidden: Under the restricted staff setting, course owners manage team membership.",
  );
  const owner = (await call("GET", `/api/admin/desk/teams/${w.ids.teamA}`, { who: world.who.owner })).json;
  expect(owner.team.members.map((member) => member.login)).toEqual(expect.arrayContaining(students));
  expect(JSON.stringify(owner.commitSignals)).toContain("rj-canary-a-author-one");
  await expectNoDispatch();
});

/** Answer -> sorted identities, keys sorted, so two tables compare as text. */
function normalise(table = {}) {
  return Object.fromEntries(
    Object.entries(table)
      .map(([answer, identities]) => [answer, [...identities].sort()])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * The facts route-content.mjs checks answers against, read from one D1
 * snapshot: each team's runs, consoles and repository, each signed-in
 * identity's own CLI devices, everyone on a team, and staff coverage.
 */
function contentFacts(w, db) {
  const teams = [w.ids.teamA, w.ids.teamB];
  const of = (table, team) => new Set(db[table].filter((row) => row.team_id === team).map((row) => row.id));
  const userIdOf = new Map(db.users.map((user) => [user.email, user.id]));
  const signedIn = ["joiner", "outsider", "studentA", "teammateA", "studentB", "changedTeam", "taAssigned", "taUnassigned", "owner"];
  const memberIds = new Set(db.team_members.map((row) => row.user_id));
  return {
    ids: w.ids,
    teamOf: Object.fromEntries([...TEAM_A.map((i) => [i, w.ids.teamA]), ...TEAM_B.map((i) => [i, w.ids.teamB])]),
    loginOf: Object.fromEntries(signedIn.map((i) => [i, LOGINS[i]])),
    runsOf: Object.fromEntries(teams.map((team) => [team, of("runs", team)])),
    surfacesOf: Object.fromEntries(teams.map((team) => [team, of("run_surfaces", team)])),
    repoOf: Object.fromEntries(teams.map((team) => [team, db.teams.find((row) => row.id === team).repo_full_name])),
    devicesOf: Object.fromEntries(
      signedIn.map((i) => [i, new Set(db.cli_devices.filter((d) => d.user_id === userIdOf.get(`${LOGINS[i]}@dev.local`)).map((d) => d.id))]),
    ),
    onSomeTeam: new Set(db.users.filter((u) => memberIds.has(u.id)).flatMap((u) => [u.github_login, u.email.split("@")[0]]).filter(Boolean)),
    staffTeams: { taAssigned: [w.ids.teamA], taUnassigned: [w.ids.teamB], owner: "all" },
  };
}

/**
 * Columns a refused request may still write, and why. A CLI device's token
 * is checked before its request's body, and using a live token records the
 * time (worker/auth/device.ts) even when the body is then refused.
 */
const VOLATILE = { cli_devices: ["last_used_at"] };

/** Rows added or removed between two D1 snapshots, ignoring VOLATILE columns. */
function changedRows(before, after) {
  const changes = [];
  for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const skip = VOLATILE[table] ?? [];
    const key = (row) => JSON.stringify(Object.entries(row).filter(([column]) => !skip.includes(column)));
    const count = (rows) => rows.reduce((map, row) => map.set(key(row), (map.get(key(row)) ?? 0) + 1), new Map());
    const was = count(before[table] ?? []);
    const now = count(after[table] ?? []);
    const added = [...now].filter(([row, n]) => n > (was.get(row) ?? 0)).map(([row]) => row);
    const removed = [...was].filter(([row, n]) => n > (now.get(row) ?? 0)).map(([row]) => row);
    if (added.length || removed.length) changes.push({ table, added: added.slice(0, 3), removed: removed.slice(0, 3) });
  }
  return changes;
}
