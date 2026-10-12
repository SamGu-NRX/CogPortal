// A populated portal for the authorization matrix and the adversarial
// journeys: two teams, their staff, an owner, a run, a run surface, CLI
// devices and Activity sessions, each made through the Worker's own routes
// wherever a route exists. Only role and membership changes no route can make
// for a dev account (TA assignment, a team on a seeded repository, an expired
// session or device) are written to the run's D1 directly.
//
// Requests are plain HTTP with explicit cookies and tokens, so one identity
// can't borrow another's session the way a shared browser context would.

import { ACTIVITY, STACK, control, doubles } from "./helpers.mjs";

/** Synthetic logins; none is a real person's handle. */
export const LOGINS = {
  studentA: "rj-m-student-a",
  teammateA: "rj-m-teammate-a",
  studentB: "rj-m-student-b",
  taAssigned: "rj-m-ta-assigned",
  taUnassigned: "rj-m-ta-unassigned",
  owner: "owner-person",
  revoked: "rj-m-revoked",
  expired: "rj-m-expired",
  changedTeam: "rj-m-changed-team",
  outsider: "rj-m-outsider",
  joiner: "rj-m-joiner",
};

/** The seeded team that stands as "the other team" (scripts/seed-local.sql). */
export const TEAM_B = "team_eigenfaces";

function cookieHeader(response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

/** One HTTP call as an identity. `who` carries `cookie` and/or `bearer`. */
export async function call(method, path, { who = {}, body, base = STACK, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: "manual",
    headers: {
      origin: base,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(who.cookie ? { cookie: who.cookie } : {}),
      ...(who.bearer ? { authorization: `Bearer ${who.bearer}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text, response };
}

async function ok(result, what) {
  if (result.status >= 300) throw new Error(`${what} answered ${result.status}: ${result.text}`);
  return result.json;
}

export async function devLogin(login, { demo = false } = {}) {
  const response = await fetch(`${STACK}/api/dev/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: STACK },
    body: JSON.stringify({ login, demo }),
  });
  if (!response.ok) throw new Error(`dev login ${login}: ${response.status} ${await response.text()}`);
  return { cookie: cookieHeader(response), session: await response.json() };
}

const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`;
export const userId = async (login) =>
  (await control.sql(`SELECT id FROM users WHERE email = ${sqlText(`${login}@dev.local`)}`))[0].id;

/** Links a CLI device for `who` through the real device flow. */
export async function linkDevice(who, name) {
  const start = await ok(await call("POST", "/api/v1/cli/device/start"), "device start");
  await ok(await call("POST", "/api/v1/cli/device/approve", { who, body: { userCode: start.userCode, deviceName: name } }), "device approve");
  const token = await ok(await call("POST", "/api/v1/cli/device/token", { body: { deviceCode: start.deviceCode } }), "device token");
  const [{ id }] = await control.sql(`SELECT id FROM cli_devices WHERE name = ${sqlText(name)}`);
  return { bearer: token.token, deviceId: id };
}

/**
 * An Activity session (on the Activity's host) for a synthetic Discord user,
 * through the Worker's real code exchange against the Discord double.
 * `linkWith` links it to a portal identity through the portal's confirm route.
 */
export async function activitySession(discordUser, code, { linkWith } = {}) {
  await doubles.discordCode(code, discordUser);
  const state = await fetch(`${ACTIVITY}/api/activity/oauth/state`, { headers: { origin: ACTIVITY } });
  const stateCookie = cookieHeader(state);
  const { state: value } = await state.json();
  const token = await fetch(`${ACTIVITY}/api/activity/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ACTIVITY, cookie: stateCookie },
    body: JSON.stringify({ code, state: value }),
  });
  if (!token.ok) throw new Error(`activity token: ${token.status} ${await token.text()}`);
  const who = { cookie: cookieHeader(token) };
  if (linkWith) {
    const session = await ok(await call("GET", "/api/activity/session", { who, base: ACTIVITY }), "activity session");
    const linkToken = new URL(session.linkUrl).hash.replace("#discord=", "");
    await ok(await call("POST", "/api/v1/connections/discord/confirm", { who: linkWith, body: { token: linkToken } }), "discord confirm");
  }
  return who;
}

/** Starts a practice run as `who` on their shown team and waits for it to finish. */
export async function practiceRun(who, teamId, { branch = "main", benchmarkId } = {}) {
  const dashboard = await ok(await call("GET", "/api/dashboard", { who }), "dashboard");
  const started = await ok(
    await call("POST", "/api/runs/practice", { who, body: { teamId, benchmarkId: benchmarkId ?? dashboard.benchmark.id, branch } }),
    "practice start",
  );
  for (let i = 0; i < 120; i += 1) {
    const run = await ok(await call("GET", `/api/runs/${started.runId}`, { who }), "run read");
    if (run.status === "succeeded" || run.status === "failed") return run;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`run ${started.runId} never finished`);
}

async function joinTeamB(login) {
  await control.sql(
    `INSERT INTO team_members (team_id, user_id, role) VALUES (${sqlText(TEAM_B)}, ${sqlText(await userId(login))}, 'write')`,
  );
}

/**
 * Builds the world. Returns identities (`who` objects) and the ids the
 * matrix's requests name.
 */
export async function buildWorld() {
  const a = await devLogin(LOGINS.studentA, { demo: true });
  const teamA = a.session.team.id;
  const teammate = await devLogin(LOGINS.teammateA);
  // The teammate joins team A through the cohort and team routes.
  await ok(await call("POST", "/api/cohorts/join", { who: teammate, body: { code: "VISION26" } }), "teammate cohort");
  await ok(await call("POST", "/api/team/join", { who: teammate, body: { teamId: teamA } }), "teammate join");

  const b = await devLogin(LOGINS.studentB);
  await ok(await call("POST", "/api/cohorts/join", { who: b, body: { code: "VISION26" } }), "student B cohort");
  // Joining any repository but the fixture's needs GitHub access a dev
  // account can't have, so team B's membership is written directly.
  await joinTeamB(LOGINS.studentB);

  const taAssigned = await devLogin(LOGINS.taAssigned);
  const taUnassigned = await devLogin(LOGINS.taUnassigned);
  const owner = await devLogin(LOGINS.owner);
  // Signed in and nothing else: no cohort, no team.
  const joiner = await devLogin(LOGINS.joiner);
  // On a team long enough to link Discord (confirming a link needs a team),
  // then off it: a cohort member with no team, and a linked Activity
  // identity with no team behind it.
  const outsider = await devLogin(LOGINS.outsider, { demo: true });
  const activityNoTeam = await activitySession({ id: "900000000000000202", username: "rj-m-discord-outsider" }, "rj-m-code-outsider", { linkWith: outsider });
  await ok(await call("POST", "/api/team/leave", { who: outsider, body: { teamId: outsider.session.team.id } }), "outsider leave");
  await control.sql(`INSERT INTO team_tas (team_id, user_id, assigned_at) VALUES (${sqlText(teamA)}, ${sqlText(await userId(LOGINS.taAssigned))}, 1)`);
  await control.sql(`INSERT INTO team_tas (team_id, user_id, assigned_at) VALUES (${sqlText(TEAM_B)}, ${sqlText(await userId(LOGINS.taUnassigned))}, 1)`);

  // A finished run and its console on team A.
  const run = await practiceRun(a, teamA);
  const [{ surface_id: surfaceId }] = await control.sql(`SELECT surface_id FROM runs WHERE id = ${sqlText(run.id)}`);

  // Sessions that stop being valid: one signed out on the server (its row
  // gone, the cookie kept), one past its expiry.
  const revoked = await devLogin(LOGINS.revoked, { demo: true });
  await control.sql(`DELETE FROM sessions WHERE user_id = ${sqlText(await userId(LOGINS.revoked))}`);
  const expired = await devLogin(LOGINS.expired, { demo: true });
  await control.sql(`UPDATE sessions SET expires_at = 1000 WHERE user_id = ${sqlText(await userId(LOGINS.expired))}`);

  // A team A member who has since moved to team B; their cookie predates the move.
  const changed = await devLogin(LOGINS.changedTeam, { demo: true });
  const changedId = await userId(LOGINS.changedTeam);
  await ok(await call("POST", "/api/team/leave", { who: changed, body: { teamId: teamA } }), "changed leave");
  await joinTeamB(LOGINS.changedTeam);

  // CLI devices for student A: live, revoked through the portal, expired.
  const device = await linkDevice(a, "rj-m-device-live");
  const deviceRevoked = await linkDevice(a, "rj-m-device-revoked");
  await ok(await call("DELETE", "/api/v1/cli/devices", { who: a, body: { deviceId: deviceRevoked.deviceId } }), "device revoke");
  const deviceExpired = await linkDevice(a, "rj-m-device-expired");
  await control.sql(`UPDATE cli_devices SET expires_at = 1000 WHERE id = ${sqlText(deviceExpired.deviceId)}`);
  const deviceB = await linkDevice(b, "rj-m-device-b");

  // Activity sessions: linked to student A, and one never linked.
  const activityA = await activitySession({ id: "900000000000000201", username: "rj-m-discord-a" }, "rj-m-code-a", { linkWith: a });
  const activityUnlinked = await activitySession({ id: "900000000000000203", username: "rj-m-discord-unlinked" }, "rj-m-code-unlinked");

  return {
    ids: { teamA, teamB: TEAM_B, runA: run.id, surfaceA: surfaceId, changedId, deviceA: device.deviceId },
    who: {
      signedOut: {},
      studentA: a,
      teammateA: teammate,
      studentB: b,
      taAssigned,
      taUnassigned,
      owner,
      outsider,
      joiner,
      revoked,
      expired,
      changedTeam: changed,
      deviceA: { bearer: device.bearer },
      deviceRevoked: { bearer: deviceRevoked.bearer },
      deviceExpired: { bearer: deviceExpired.bearer },
      deviceB: { bearer: deviceB.bearer },
      activityA,
      activityNoTeam,
      activityUnlinked,
    },
  };
}
