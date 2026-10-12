/**
 * Registry of protected routes, rebuilt from the Worker's registered routes
 * (apps/portal/worker/index.ts mounts 17 route registrars under /api plus the
 * Better Auth handler at /api/auth/*). Every path is a mounted path — the
 * /api prefix included.
 *
 * Each probe is a mutation or a team-scoped read that MUST refuse an
 * anonymous caller with the exact status AND body error code the registry
 * records (`errorResponse` bodies are { error: { code, message } }; the
 * plain-text check-off route carries no code). `guard` names the
 * source-level guard.
 *
 * `own` names the positive control: the legitimate holder of the credential
 * the guard demands replays the IDENTICAL request and must get a 2xx.
 * Without that control an over-broad guard that refuses everyone would pass.
 * Kinds:
 *   user   — a signed-in dev account (no team needed)
 *   team   — a signed-in team member (admin where the route demands it)
 *   device — a linked CLI device token (Bearer cog_…)
 *   skip   — the control cannot run in the journey stack; ownNote says why
 *
 * `{placeholders}` are filled by the journeys from objects that actually
 * exist (resolveProbe) — a probe against a made-up id proves nothing about
 * authorization.
 *
 * Deliberately absent from this registry:
 *   POST /api/dev/login and POST /api/v1/cli/device/start — public
 *     identity/issuer routes by design (an anonymous caller is SUPPOSED to
 *     get a session or a device code).
 *   GET /api/auth/get-session — Better Auth answers anonymous sessions
 *     200/null.
 *   The GitHub webhook — without GITHUB_WEBHOOK_SECRET (the journey stack
 *     configures none) the guard answers 501 provider_unconfigured: an
 *     environment gap, not a refusal this registry can assert.
 */
export type Refusal = { status?: number; code?: string };

export type Probe = {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  guard: string;
  /** Exact refusal an anonymous caller must see. */
  refuse: Refusal;
  /** The positive control's actor kind, or "skip" with a reason. */
  own: "user" | "team" | "device" | "skip";
  ownNote?: string;
};

/** No staff identity exists in the journey stack for admin-route controls. */
const noStaff =
  "the journey stack has no staff identity (PLATFORM_OWNER_LOGINS is unset and platform_staff is unseeded), so no owner can replay admin requests";

/** A well-formed device code no device authorization holds. */
const unknownDeviceCode = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

export const UNAUTHENTICATED_PROBES: Probe[] = [
  // --- identity / github (requireUser / requireTeam sessions) ---
  { method: "POST", path: "/api/cohorts/join", body: { code: "{joinCode}" }, guard: "requireUser", refuse: { status: 401, code: "unauthorized" }, own: "user" },
  { method: "POST", path: "/api/github/connect", body: { fullName: "{fixtureRepo}", teamName: "SEC Connect Probe" }, guard: "requireUser", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "GET", path: "/api/github/repositories", guard: "requireUser", refuse: { status: 401, code: "unauthorized" }, own: "user" },
  { method: "GET", path: "/api/github/installations", guard: "requireUser", refuse: { status: 401, code: "unauthorized" }, own: "user" },
  { method: "GET", path: "/api/activity/session", guard: "requireUser", refuse: { status: 401, code: "unauthorized" }, own: "user" },
  { method: "GET", path: "/api/activity/run-surfaces", guard: "requireUser", refuse: { status: 401, code: "unauthorized" }, own: "user" },
  { method: "POST", path: "/api/activity/run-surfaces/{surfaceId}/actions/{action}", body: {}, guard: "requireUser (surface scope)", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  // --- cohorts / teams / members ---
  { method: "GET", path: "/api/cohorts/teams", guard: "requireCohort", refuse: { status: 401, code: "unauthorized" }, own: "user" },
  { method: "POST", path: "/api/team/join", body: { teamId: "{seedTeamId}" }, guard: "requireUser", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: "joining a team is stateful (approval and quota semantics are unmodeled); the owner-side join runs through cohorts/join plus github/connect at bootstrap" },
  { method: "POST", path: "/api/team/leave", guard: "requireUser", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: "the only team a control could leave is the single fixture team every other control depends on; one fixture repo cannot create a second team" },
  { method: "GET", path: "/api/team", guard: "requireTeam", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "GET", path: "/api/v1/team/process", guard: "requireTeam", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "PATCH", path: "/api/team", body: { name: "SEC Renamed Team", teamId: "{teamId}" }, guard: "requireTeamAdmin + requireShownTeam", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "POST", path: "/api/team/repository", body: { fullName: "{fixtureRepo}", teamId: "{teamId}" }, guard: "requireTeamAdmin", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "GET", path: "/api/team/invitable", guard: "requireTeamAdmin", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "POST", path: "/api/team/members", body: { login: "{secondLogin}", teamId: "{teamId}" }, guard: "requireTeamAdmin", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "DELETE", path: "/api/team/members/{secondLogin}", guard: "requireTeamAdmin", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  // --- runs ---
  { method: "GET", path: "/api/runs", guard: "requireTeam", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "POST", path: "/api/runs/practice", body: { benchmarkId: "{benchmarkId}", branch: "{branch}", teamId: "{teamId}" }, guard: "requireShownTeam", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "GET", path: "/api/runs/{runId}", guard: "requireTeam (run scoped to team)", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "POST", path: "/api/runs/{runId}/promote", guard: "requireTeam (run scoped to team)", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "PUT", path: "/api/leaderboard-selection", body: { runId: "{runId}" }, guard: "requireTeam (run scoped to team)", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "GET", path: "/api/dashboard", guard: "requireTeam", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  // --- run surfaces ---
  { method: "GET", path: "/api/run-surfaces", guard: "requireTeam", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "GET", path: "/api/run-surfaces/{surfaceId}", guard: "requireTeam (surface scoped to team)", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "GET", path: "/api/run-surfaces/{surfaceId}/stream", guard: "requireTeam (surface scoped to team)", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "POST", path: "/api/run-surfaces/{surfaceId}/actions/{action}", body: {}, guard: "requireTeam (surface scoped to team)", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  // --- connections (discord) ---
  { method: "GET", path: "/api/v1/connections", guard: "requireUser", refuse: { status: 401, code: "unauthorized" }, own: "user" },
  { method: "POST", path: "/api/v1/connections/discord/preview", body: { code: "sec-preview-code" }, guard: "requireTeam", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: "a control needs a real Discord OAuth code; the journey stack configures no Discord app (the owner would see 501 provider_unconfigured)" },
  { method: "POST", path: "/api/v1/connections/discord/confirm", body: { code: "sec-confirm-code" }, guard: "requireTeam", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: "a control needs a real Discord OAuth code; the journey stack configures no Discord app (the owner would see 501 provider_unconfigured)" },
  { method: "DELETE", path: "/api/v1/connections/discord", guard: "requireUser", refuse: { status: 401, code: "unauthorized" }, own: "user" },
  // --- device flow (user-facing arms need a session; token exchange is public) ---
  { method: "POST", path: "/api/v1/cli/device/approve", body: { userCode: "SECCODE1", deviceName: "sec-box" }, guard: "requireTeam", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "GET", path: "/api/v1/cli/device/status", guard: "requireUser or requireDevice", refuse: { status: 401, code: "unauthorized" }, own: "user" },
  { method: "POST", path: "/api/v1/cli/device/token", body: { deviceCode: unknownDeviceCode }, guard: "public device-code exchange", refuse: { status: 410, code: "link_expired" }, own: "skip", ownNote: "the credential IS the device code; the positive control (start, then poll to 200 pending) is exercised by linkDevice at bootstrap" },
  { method: "DELETE", path: "/api/v1/cli/devices", body: { deviceId: "cli_sec00000000000000000000" }, guard: "requireUser", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: "revoking needs a real device id, which linkDevice does not surface (it returns the token); an unknown id is not a 2xx control" },
  // --- local runs (device-scoped) ---
  { method: "POST", path: "/api/v1/local-runs", body: { clientRunId: "localrun_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", benchmarkId: "{benchmarkId}", benchmarkVersion: 1, repositoryId: null, repositoryFullName: "{fixtureRepo}", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", branch: "{branch}", dirty: false }, guard: "requireDevice", refuse: { status: 401, code: "invalid_token" }, own: "device" },
  { method: "POST", path: "/api/v1/local-runs/{clientRunId}/events", body: { eventId: "sec0001", sequence: 1, occurredAt: 0, type: "progress", phase: "running" }, guard: "requireDevice", refuse: { status: 401, code: "invalid_token" }, own: "device" },
  { method: "POST", path: "/api/v1/local-runs/{clientRunId}/events/batch", body: { events: [{ eventId: "sec0002", sequence: 1, occurredAt: 0, type: "progress", phase: "running" }] }, guard: "requireDevice", refuse: { status: 401, code: "invalid_token" }, own: "device" },
  // --- local reports / weights (device or team scoped) ---
  { method: "POST", path: "/api/v1/local-reports", body: {}, guard: "requireDevice", refuse: { status: 401, code: "invalid_token" }, own: "skip", ownNote: "LocalReportInputSchema is not modeled in the harness; the refusal arm still asserts the exact 401 invalid_token" },
  { method: "PUT", path: "/api/v1/local-reports/{reportId}/weights/w.bin", body: "x", headers: { "x-cogworks-weight-sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, guard: "requireDevice", refuse: { status: 401, code: "invalid_token" }, own: "skip", ownNote: "a control needs a real report id and weight digest, which the harness does not model; the refusal arm still asserts the exact 401 invalid_token" },
  { method: "GET", path: "/api/v1/local-reports", guard: "requireTeam", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  // --- runner internal callbacks (HMAC) ---
  { method: "POST", path: "/api/internal/v1/runner/events", body: {}, guard: "runner HMAC", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: "a control needs a live run plus the runner event contract (j5's scope); the refusal arm still asserts the exact 401 unauthorized" },
  { method: "GET", path: "/api/v1/runs/{runId}/weights/w.bin", guard: "runner HMAC", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: "a control needs a live run plus the runner identity contract (j5's scope); the refusal arm still asserts the exact 401 unauthorized" },
  // --- setup / check-off ---
  { method: "GET", path: "/api/v1/setup/state", guard: "requireTeam", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  { method: "POST", path: "/api/v1/setup/check-off", guard: "signed check-off token", refuse: { status: 400 }, own: "team" },
  { method: "POST", path: "/api/v1/cli/setup/checks", body: {}, guard: "requireDevice", refuse: { status: 401, code: "invalid_token" }, own: "skip", ownNote: "SetupEvidenceRequestSchema is not modeled in the harness; the refusal arm still asserts the exact 401 invalid_token" },
  { method: "DELETE", path: "/api/v1/setup/state", guard: "requireTeam", refuse: { status: 401, code: "unauthorized" }, own: "team" },
  // --- admin (staff) ---
  { method: "GET", path: "/api/admin/overview", guard: "requireStaff", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: noStaff },
  { method: "PATCH", path: "/api/admin/cohort", body: { name: "SEC26 Cohort" }, guard: "requireStaff", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: noStaff },
  { method: "PATCH", path: "/api/admin/teams/{seedTeamId}", body: { name: "SEC Renamed Seeded Team" }, guard: "requireStaff", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: noStaff },
  { method: "POST", path: "/api/admin/teams/{seedTeamId}/members", body: { login: "{secondLogin}" }, guard: "requireStaff", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: noStaff },
  { method: "DELETE", path: "/api/admin/teams/{seedTeamId}/members/{secondLogin}", guard: "requireStaff", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: noStaff },
  { method: "POST", path: "/api/admin/teams/{seedTeamId}/tas", body: { login: "{secondLogin}" }, guard: "requireStaff", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: noStaff },
  { method: "DELETE", path: "/api/admin/teams/{seedTeamId}/tas/{secondLogin}", guard: "requireStaff", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: noStaff },
  { method: "GET", path: "/api/admin/staff", guard: "requireStaff", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: noStaff },
  { method: "POST", path: "/api/admin/staff", body: { login: "{secondLogin}" }, guard: "requireStaff", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: noStaff },
  { method: "DELETE", path: "/api/admin/staff/{secondLogin}", guard: "requireStaff", refuse: { status: 401, code: "unauthorized" }, own: "skip", ownNote: noStaff },
];

/**
 * Fill `{name}` placeholders from vars — in the path, in body strings and
 * nested values, and in header values. Unknown placeholders are left alone.
 */
export function resolveProbe(probe: Probe, vars: Record<string, string>): Probe {
  const sub = (s: string): string => s.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? vars[key] : whole));
  const deep = (value: unknown): unknown => {
    if (typeof value === "string") return sub(value);
    if (Array.isArray(value)) return value.map(deep);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)]));
    }
    return value;
  };
  return {
    ...probe,
    path: sub(probe.path),
    body: probe.body === undefined ? undefined : deep(probe.body),
    headers: probe.headers === undefined ? undefined : Object.fromEntries(Object.entries(probe.headers).map(([k, v]) => [k, sub(v)])),
  };
}
