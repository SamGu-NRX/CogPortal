/**
 * Registry of protected routes (the ~60-route inventory across 17 registrars).
 * Each probe is a mutation or a team-scoped read that MUST refuse an anonymous
 * caller. `guard` names the source-level guard the route sits behind
 * (requireTeam / requireShownTeam / requireStaff / session / device).
 */
export type Probe = {
  method: string;
  path: string;
  body?: unknown;
  guard: string;
};

const teamName = "SEC Sample Team";

export const UNAUTHENTICATED_PROBES: Probe[] = [
  // --- auth-shaped and identity routes ---
  { method: "GET", path: "/api/auth/get-session", guard: "session" },
  { method: "GET", path: "/api/github/me", guard: "session" },
  { method: "GET", path: "/api/github/teams", guard: "session" },
  { method: "GET", path: "/api/github/repos", guard: "session" },
  { method: "POST", path: "/api/github/connect", body: { fullName: "cogworks-demo/face-finder", teamName }, guard: "session" },
  { method: "GET", path: "/api/activity", guard: "session" },
  { method: "GET", path: "/api/activity/discord", guard: "session" },
  { method: "POST", path: "/api/activity/discord/link", body: {}, guard: "session" },
  { method: "POST", path: "/api/activity/discord/unlink", body: {}, guard: "session" },
  { method: "GET", path: "/api/dev/login", guard: "devAuth (env-gated)" },
  { method: "POST", path: "/api/dev/login", body: { login: "secanon", demo: true }, guard: "devAuth (env-gated)" },
  // --- cohorts / teams / members ---
  { method: "GET", path: "/api/cohorts", guard: "session" },
  { method: "POST", path: "/api/cohorts/join", body: { joinCode: "VISION26" }, guard: "session" },
  { method: "GET", path: "/api/team", guard: "session" },
  { method: "GET", path: "/api/team/members", guard: "requireTeam" },
  { method: "POST", path: "/api/team/members/invite", body: { email: "sec@example.edu" }, guard: "requireTeam" },
  { method: "DELETE", path: "/api/team/members/invite", body: { email: "sec@example.edu" }, guard: "requireTeam" },
  // --- runs ---
  { method: "GET", path: "/api/runs", guard: "session" },
  { method: "POST", path: "/api/runs/practice", body: { benchmarkId: 1, branch: "main" }, guard: "session" },
  { method: "POST", path: "/api/runs/official", body: { runId: "run_sec00000000000000000000" }, guard: "session" },
  { method: "POST", path: "/api/runs", body: { runId: "run_sec00000000000000000000" }, guard: "session" },
  { method: "GET", path: "/api/runs/run_sec00000000000000000000", guard: "session (scoped 404)" },
  { method: "GET", path: "/api/runs/run_sec00000000000000000000/log", guard: "session (scoped 404)" },
  { method: "GET", path: "/api/runs/run_sec00000000000000000000/process", guard: "session (scoped 404)" },
  { method: "POST", path: "/api/runs/run_sec00000000000000000000/promote", guard: "session (scoped 404)" },
  // --- run surfaces ---
  { method: "GET", path: "/api/run-surfaces/surface_sec00000000000000000000", guard: "session" },
  { method: "GET", path: "/api/run-surfaces/surface_sec00000000000000000000/events", guard: "session" },
  { method: "POST", path: "/api/run-surfaces", body: { runId: "run_sec00000000000000000000", type: "table" }, guard: "session" },
  // --- leaderboard / dashboard / benchmarks ---
  { method: "PUT", path: "/api/leaderboard-selection", body: { runId: "run_sec00000000000000000000" }, guard: "session" },
  { method: "GET", path: "/api/dashboard", guard: "session" },
  { method: "POST", path: "/api/benchmarks", body: { name: "sec-bench" }, guard: "staff" },
  // --- setup / check-off ---
  { method: "GET", path: "/api/setup/checkoff", guard: "session" },
  { method: "POST", path: "/api/setup/checkoff", body: { step: 1 }, guard: "session" },
  // --- device-flow (user-facing parts need a session; token exchange does not) ---
  { method: "POST", path: "/v1/cli/device/approve", body: { userCode: "SECCODE1", deviceName: "sec-box" }, guard: "session" },
  { method: "GET", path: "/v1/cli/device/status", guard: "device code" },
  // --- local runs (device-scoped) ---
  { method: "POST", path: "/v1/local-runs", body: {}, guard: "device token" },
  { method: "POST", path: "/v1/local-runs/localrun_sec00000000000000000000/events", body: { events: [] }, guard: "device token" },
  { method: "POST", path: "/v1/local-runs/localrun_sec00000000000000000000/finish", body: {}, guard: "device token" },
  // --- local reports / weights (device or staff scoped) ---
  { method: "GET", path: "/v1/local-reports/report_sec00000000000000000000", guard: "device token" },
  { method: "PUT", path: "/v1/local-reports/report_sec00000000000000000000/weights/w.bin", body: "x", guard: "device token" },
  { method: "GET", path: "/v1/local-reports/report_sec00000000000000000000/weights/w.bin", guard: "signed runner" },
  { method: "GET", path: "/api/local-reports", guard: "session" },
  // --- runner internal callbacks ---
  { method: "POST", path: "/api/internal/v1/runner/events", body: { events: [] }, guard: "runner HMAC" },
  // --- admin ---
  { method: "GET", path: "/api/admin/cohorts", guard: "staff" },
  { method: "POST", path: "/api/admin/cohorts", body: { name: "SEC26" }, guard: "staff" },
];
