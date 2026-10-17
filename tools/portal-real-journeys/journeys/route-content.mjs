// What a successful answer must be about, per route: the caller's own team,
// run, console, devices and staff scope, and nobody else's. Checked by
// s5-route-matrix.journey.mjs on every 2xx cell, alongside the canary scan
// (canaries.mjs), which catches private data in any answer.
//
// A check returns null when the answer is right for `identity`, or a
// sentence saying what is wrong. `f` holds the world's facts (see
// contentFacts in s5-route-matrix.journey.mjs): which team each identity
// acts for, each team's run and console ids, each identity's own CLI
// devices, and which teams each staff member covers. The matrix checks
// every 2xx cell against these rows, the positive controls included: each
// positive names the caller it runs as, and every dev-local account the run
// created has facts of its own.

const isArray = (value) => Array.isArray(value);
const ids = (rows, key = "id") => rows.map((row) => row[key]).sort();
const outside = (values, allowed) => values.filter((value) => !allowed.has(value));

/** The session an identity holds: itself signed in, or nobody. */
function ownSession(json, identity, f) {
  const login = f.loginOf[identity];
  if (!login) return json?.user === null ? null : `answers with ${json?.user?.login ?? "a user"} for a caller with no portal session`;
  if (json?.user?.login !== login) return `answers as ${json?.user?.login} for ${login}`;
  const team = f.teamOf[identity] ?? null;
  if ((json.team?.id ?? null) !== team) return `names team ${json.team?.id ?? null}, the caller's is ${team}`;
  return null;
}

function ownTeamRuns(rows, identity, f) {
  if (!isArray(rows)) return "is not a list of runs";
  const foreign = outside(ids(rows), f.runsOf[f.teamOf[identity]]);
  return foreign.length ? `lists runs of another team: ${foreign.join(", ")}` : null;
}

function ownTeamSurfaces(rows, identity, f) {
  if (!isArray(rows)) return "is not a list of consoles";
  const team = f.teamOf[identity];
  const foreign = rows.filter((row) => row.team?.id !== team || !f.surfacesOf[team].has(row.id)).map((row) => row.id);
  return foreign.length ? `lists consoles of another team: ${foreign.join(", ")}` : null;
}

function ownDevices(json, identity, f) {
  if (!isArray(json?.cliDevices)) return "has no device list";
  const foreign = outside(ids(json.cliDevices), f.devicesOf[identity] ?? new Set());
  return foreign.length ? `lists someone else's CLI devices: ${foreign.join(", ")}` : null;
}

/** Staff answers list exactly the teams the caller covers (the owner covers all). */
function staffTeams(rows, identity, f) {
  if (!isArray(rows)) return "is not a list of teams";
  const covered = f.staffTeams[identity];
  if (covered === "all") return rows.length >= 2 ? null : `lists ${rows.length} teams to the owner`;
  const got = ids(rows);
  return JSON.stringify(got) === JSON.stringify([...covered].sort()) ? null : `lists teams ${got.join(", ")}; ${identity} covers ${[...covered].join(", ")}`;
}

const teamIs = (team, want) => (team === want ? null : `is about team ${team}, not ${want}`);
const object = (json) => (json && typeof json === "object" ? null : "is empty");
const leaderboard = (json) => (isArray(json?.entries) && !json.entries.some((e) => e.isYou) ? null : "marks an entry as the caller's, or has no entries");

export const CONTENT = {
  // Better Auth's own session read. Portal sessions are the portal's, so it
  // reports none; it must never report another person's.
  "ALL /api/auth/*": (json, identity, f) =>
    json === null || json?.user?.email === `${f.loginOf[identity]}@dev.local` ? null : `reports a session for ${json?.user?.email}`,
  "GET /api/session": ownSession,
  "POST /api/session/logout": (json) => (json?.user === null ? null : `still reports ${json?.user?.login} signed in`),
  "GET /api/github/repositories": (json) =>
    isArray(json) && json.every((repo) => typeof repo.fullName === "string") ? null : "is not a list of repositories",
  "GET /api/runs": ownTeamRuns,
  "GET /api/runs/:id": (json, identity, f) => (json?.id === f.ids.runA ? null : `is run ${json?.id}`),
  "GET /api/dashboard": (json, identity, f) => teamIs(json?.team?.id, f.teamOf[identity]) ?? ownTeamRuns(json.runs, identity, f),
  "GET /api/leaderboard": leaderboard,
  "GET /api/v1/leaderboard": leaderboard,
  "GET /api/leaderboard-family": object,
  "GET /api/benchmarks": (json) => (isArray(json) && json.length > 0 ? null : "lists no benchmarks"),
  "GET /api/v1/benchmarks": (json) => (isArray(json) && json.length > 0 ? null : "lists no benchmarks"),
  "GET /api/team": (json, identity, f) => teamIs(json?.id, f.teamOf[identity]),
  "GET /api/v1/team/process": (json) => (typeof json?.historyQuality === "string" ? null : "has no history reading"),
  "PATCH /api/team": (json, identity, f) => teamIs(json?.id, f.teamOf[identity]),
  "POST /api/team/repository": (json, identity, f) => teamIs(json?.id, f.teamOf[identity]),
  "GET /api/cohorts/teams": (json) => (isArray(json?.teams ?? json) ? null : "is not a list of teams"),
  // A 2xx leave answers the route's shape and ends with the caller off every
  // team: the route removes the one membership and 409s when the caller is on
  // another team instead. The positive control signs in with the dev-auth demo
  // provisioning, which auto-connects the caller to Demo Team, so its answer
  // is a first leave — alreadyLeft:false — and the end state is the invariant,
  // not the field's value.
  "POST /api/team/leave": (json, identity, f) =>
    typeof json?.alreadyLeft === "boolean" && !f.onSomeTeam.has(identity)
      ? null
      : "answers 2xx without leaving the caller off every team",
  "GET /api/team/invitable": (json, identity, f) => {
    const rows = json?.users ?? json;
    if (!isArray(rows)) return "is not a list of people";
    const onTeams = rows.map((u) => u.login).filter((login) => f.onSomeTeam.has(login));
    return onTeams.length ? `offers people already on a team: ${onTeams.join(", ")}` : null;
  },
  "GET /api/v1/connections": ownDevices,
  "DELETE /api/v1/cli/devices": ownDevices,
  "DELETE /api/v1/connections/discord": ownDevices,
  "POST /api/v1/cli/device/start": (json) => (typeof json?.deviceCode === "string" && typeof json?.userCode === "string" ? null : "has no device and user code"),
  "GET /api/v1/cli/device/status": (json, identity, f) =>
    json?.repositoryFullName === f.repoOf[f.teamOf[identity]] ? null : `describes a device on ${json?.repositoryFullName}`,
  "POST /api/v1/local-reports": (json, identity, f) =>
    json?.repositoryFullName === f.repoOf[f.teamOf[identity]] ? null : `stores a report for ${json?.repositoryFullName}`,
  "GET /api/v1/local-reports": (json, identity, f) => {
    if (!isArray(json)) return "is not a list of reports";
    const foreign = json.filter((r) => r.repositoryFullName !== f.repoOf[f.teamOf[identity]]).map((r) => r.reportId);
    return foreign.length ? `lists reports of another team: ${foreign.join(", ")}` : null;
  },
  "POST /api/v1/local-runs": (json) => (typeof json?.sessionId === "string" && typeof json?.surfaceId === "string" ? null : "has no session and console"),
  "POST /api/v1/local-runs/:id/events": object,
  "POST /api/v1/local-runs/:id/events/batch": object,
  "GET /api/run-surfaces": ownTeamSurfaces,
  "GET /api/run-surfaces/:id": (json, identity, f) => (json?.id === f.ids.surfaceA ? teamIs(json.team?.id, f.teamOf[identity]) : `is console ${json?.id}`),
  "GET /api/admin/overview": (json, identity, f) => staffTeams(json?.teams, identity, f),
  "PATCH /api/admin/cohort": object,
  "PATCH /api/admin/teams/:teamId": (json, identity, f) => teamIs(json?.id, f.ids.teamA),
  "DELETE /api/admin/teams/:teamId/members/:login": (json, identity, f) => teamIs(json?.id, f.ids.teamA),
  "DELETE /api/admin/teams/:teamId/tas/:login": (json, identity, f) => teamIs(json?.id, f.ids.teamA),
  "GET /api/admin/staff": object,
  "POST /api/admin/staff": object,
  "DELETE /api/admin/staff/:login": object,
  "GET /api/admin/desk/teams": (json, identity, f) => staffTeams(json?.teams, identity, f),
  "GET /api/admin/desk/teams/:teamId": (json, identity, f) => teamIs(json?.team?.id, f.ids.teamA),
  "GET /api/admin/desk/teams/:teamId/runs": (json, identity, f) => {
    if (!isArray(json?.runs)) return "has no runs";
    const foreign = outside(ids(json.runs, "runId"), f.runsOf[f.ids.teamA]);
    return foreign.length ? `lists runs of another team: ${foreign.join(", ")}` : null;
  },
  "GET /api/activity/oauth/state": (json) => (typeof json?.state === "string" && json.state.length >= 16 ? null : "has no state"),
  "GET /api/activity/session": (json, identity, f) => {
    const want = { activityA: true, activityNoTeam: "no_team", activityUnlinked: false }[identity];
    if (json?.linked !== want) return `says linked=${json?.linked}; ${identity} is ${want}`;
    return want === true ? teamIs(json.team?.id, f.ids.teamA) : null;
  },
  "GET /api/activity/run-surfaces": ownTeamSurfaces,
  "GET /api/v1/setup/state": (json) => (isArray(json?.verified) ? null : "has no setup state"),
  "POST /api/v1/cli/setup/checks": (json) => (isArray(json?.accepted) ? null : "says nothing was accepted"),
  // The rest of these rows only ever see a 2xx from a positive control: the
  // matrix's own cells hit these routes as refusals.
  "POST /api/cohorts/join": ownSession,
  "POST /api/github/connect": ownSession,
  "POST /api/runs/:id/promote": (json, identity, f) => (f.runsOf[f.teamOf[identity]]?.has(json?.runId) ? null : `promotes run ${json?.runId}, which is not the caller team's`),
  "POST /api/runs/practice": (json, identity, f) => (f.runsOf[f.teamOf[identity]]?.has(json?.runId) ? null : `starts run ${json?.runId}, which is not the caller team's`),
  "PUT /api/leaderboard-selection": (json) => (json?.ok === true ? null : `answers ${JSON.stringify(json)}`),
  "POST /api/run-surfaces/:id/actions/:action": (json, identity, f) => teamIs(json?.team?.id, f.teamOf[identity]),
  "POST /api/activity/run-surfaces/:id/actions/:action": (json, identity, f) => teamIs(json?.team?.id, f.teamOf[identity]),
  "POST /api/team/join": (json, identity, f) => teamIs(json?.id, f.teamOf[identity]),
  "POST /api/team/members": (json, identity, f) => teamIs(json?.id, f.teamOf[identity]),
  "DELETE /api/team/members/:login": (json, identity, f) => teamIs(json?.id, f.teamOf[identity]),
  "POST /api/v1/connections/discord/preview": (json) => (json?.username === "rj-m-pos-discord" ? null : `previews ${json?.username ?? "nobody"}`),
  "POST /api/v1/connections/discord/confirm": (json) => (json?.discord?.username === "rj-m-pos-discord" ? null : `links ${json?.discord?.username ?? "nobody"}`),
  "POST /api/v1/cli/device/token": (json) => (typeof json?.token === "string" && json.token.length > 0 ? null : "answers without a token"),
  "PUT /api/v1/local-reports/:reportId/weights/*": object,
  "POST /api/admin/teams/:teamId/members": (json, identity, f) => teamIs(json?.id, f.ids.teamA),
  "POST /api/admin/teams/:teamId/tas": (json, identity, f) => teamIs(json?.id, f.ids.teamA),
  "DELETE /api/v1/setup/state": (json) => (json?.ok === true ? null : "does not answer ok"),
};
