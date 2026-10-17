// Private data planted in the matrix world, and who may read each piece.
//
// The S5 matrices check every answer and every page for these values: a
// value found in an answer or a page for someone outside its `allowed` list
// is a leak, whatever the status or heading says. Each canary is unique text
// that appears nowhere else, so finding it means the private datum itself
// travelled.
//
// What is planted, and through what:
// - team A's practice run log and scorer diagnostics: written to that run's
//   D1 row (the fixture provider's scripted log is the same for every team,
//   so it can't tell teams apart);
// - a local report from each team's CLI device, through the CLI's own route,
//   with a note only that team should read;
// - a stored commit history for team A whose authors stand in for students,
//   so the staff desk has per-person work to show or withhold;
// - secrets harvested from the world after it is built: every CLI device
//   token and session cookie (no answer may ever carry one), each team A
//   member's setup check-off tokens (only that member), and the unlinked
//   Activity's Discord link token (only that Activity session).

import { ACTIVITY, control } from "./helpers.mjs";
import { call } from "./world.mjs";

/** Identities that act for team A or team B (journeys/world.mjs). */
export const TEAM_A = ["studentA", "teammateA", "deviceA", "activityA"];
export const TEAM_B = ["studentB", "changedTeam", "deviceB"];

const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`;

function localReport(w, reportId, repositoryFullName, note) {
  return {
    reportId,
    benchmarkId: "audio-identification",
    benchmarkVersion: w.versions["audio-identification"],
    contractVersion: "cogworks.submissions.v2",
    sdkVersion: "0.2.0",
    pluginVersion: "0.1.0",
    repositoryId: null,
    repositoryFullName,
    sha: "e".repeat(40),
    dirty: false,
    startedAt: 1_790_000_000_000,
    finishedAt: 1_790_000_060_000,
    metrics: [{ key: "top1", label: "Top-1", value: 0.25, unit: null, higherIsBetter: true, primary: true, precision: 3, role: "scored" }],
    diagnostics: [note],
    weightsUsed: [],
    weightsUploaded: [],
    command: "run",
  };
}

async function expectStatus(result, status, what) {
  if (result.status !== status) throw new Error(`${what} answered ${result.status}: ${result.text.slice(0, 300)}`);
  return result.json;
}

/**
 * Plants the canaries in a built world (`w` from buildWorld plus the
 * matrix's world facts) and returns them: [{ name, value, allowed }].
 * `staffWithFullView` names the staff who may read team A's per-person work
 * under the profile in force (both TAs' view of A is decided by
 * STAFF_VISIBILITY; the owner always reads it).
 */
export async function plantCanaries(w, { staffWithFullView }) {
  const canaries = [];
  const add = (name, value, allowed) => canaries.push({ name, value, allowed: [...new Set(allowed)] });

  await control.sql(
    `UPDATE runs SET log = 'rj-canary-a-run-log: Traceback in their own code', diagnostics_json = '["rj-canary-a-run-diagnostic"]' WHERE id = ${sqlText(w.ids.runA)}`,
  );
  add("team A's run log", "rj-canary-a-run-log", TEAM_A);
  add("team A's run diagnostics", "rj-canary-a-run-diagnostic", TEAM_A);

  const repoB = (await control.sql(`SELECT repo_full_name AS name FROM teams WHERE id = ${sqlText(w.ids.teamB)}`))[0].name;
  await expectStatus(
    await call("POST", "/api/v1/local-reports", { who: w.who.deviceA, body: localReport(w, "rj-canary-report-a", w.repoA, "rj-canary-a-report-note") }),
    201,
    "team A's canary report",
  );
  add("team A's local report note", "rj-canary-a-report-note", TEAM_A);
  await expectStatus(
    await call("POST", "/api/v1/local-reports", { who: w.who.deviceB, body: localReport(w, "rj-canary-report-b", repoB, "rj-canary-b-report-note") }),
    201,
    "team B's canary report",
  );
  add("team B's local report note", "rj-canary-b-report-note", TEAM_B);

  // A fresh stored read of team A's history (the shape the Team page stores,
  // test/staff-desk.test.ts seedHistory), with two authors.
  const [team] = await control.sql(`SELECT repo_full_name AS repo, default_branch AS branch FROM teams WHERE id = ${sqlText(w.ids.teamA)}`);
  const now = Date.now();
  // Files named for Week 2's stages (services/process-signals.ts), so the
  // desk attributes each stage to its authors.
  const commit = (i, author, file) => ({ sha: String(i).repeat(40).slice(0, 40), authorLogin: author, authoredAt: now - i * 3_600_000, filesChanged: [file], coAuthors: [] });
  const history = {
    kind: "commit-history.v1",
    repository: team.repo,
    branch: team.branch,
    checkedAt: now,
    result: {
      ok: true,
      commits: [
        commit(1, "rj-canary-a-author-one", "src/descriptors.py"),
        commit(2, "rj-canary-a-author-two", "src/whispers.py"),
        commit(3, "rj-canary-a-author-one", "src/descriptors.py"),
      ],
      truncated: false,
    },
  };
  await control.sql(
    `INSERT OR REPLACE INTO team_process_signals (team_id, computed_at, signals_json, history_quality) VALUES (${sqlText(w.ids.teamA)}, ${now}, ${sqlText(JSON.stringify(history))}, 'usable')`,
  );
  add("team A's per-person commit authors", "rj-canary-a-author-one", [...TEAM_A, ...staffWithFullView]);

  // Secrets no answer may carry.
  for (const [identity, who] of Object.entries(w.who)) {
    if (who.bearer) add(`${identity}'s CLI token`, who.bearer, []);
    for (const pair of (who.cookie ?? "").split("; ").filter(Boolean)) {
      const value = pair.slice(pair.indexOf("=") + 1);
      if (value.length >= 16) add(`${identity}'s cookie ${pair.slice(0, pair.indexOf("="))}`, value, []);
    }
  }
  // Setup check-off tokens, per member; one shared by two members is allowed to both.
  const tokens = new Map();
  for (const identity of ["studentA", "teammateA"]) {
    const state = await expectStatus(await call("GET", `/api/v1/setup/state?benchmarkId=${w.activeBenchmark}`, { who: w.who[identity] }), 200, `${identity}'s setup state`);
    for (const token of Object.values(state.tokens ?? {})) tokens.set(token, [...(tokens.get(token) ?? []), identity]);
  }
  if (tokens.size === 0) throw new Error("no setup check-off tokens to plant; the setup state changed shape");
  for (const [token, holders] of tokens) add(`${holders.join(" and ")}'s setup token`, token, holders);

  const session = await expectStatus(await call("GET", "/api/activity/session", { who: w.who.activityUnlinked, base: ACTIVITY }), 200, "unlinked Activity session");
  add("the unlinked Activity's link token", new URL(session.linkUrl).hash.replace("#discord=", ""), ["activityUnlinked"]);

  return canaries;
}

/** Canaries in `text` that `identity` may not read: [name]. */
export function leaks(text, identity, canaries) {
  if (!text) return [];
  return canaries.filter((c) => !c.allowed.includes(identity) && text.includes(c.value)).map((c) => c.name);
}
