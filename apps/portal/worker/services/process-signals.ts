/**
 * The process layer: four signals computed from commits and runs, not scores.
 *
 * This is a TypeScript port of `python/cogbench/src/cogbench/process.py`.
 * Read that module's docstring first -- the short version is that the
 * owner named the real failure as students "struggled with understanding
 * beyond the individual level, since some people do a lot of the work," and
 * a leaderboard cannot see that. See `docs/design/the-instrument-not-the-judge.md`,
 * "The process layer", for the full design rationale.
 *
 * Two rules hold everywhere in this module, same as the Python original,
 * enforced by tests in `apps/portal/test/process-signals.test.ts`, not just
 * convention:
 *
 * - No per-person totals, ever, in any form. `ownershipBreadth` reports
 *   which distinct people touched a stage, never how many commits or lines
 *   came from any one of them. `stageFootprint` reports a stage-wide count
 *   of distinct authors, a bus-factor number, not a leaderboard.
 * - Never interpolate. A signal this module cannot compute returns `null`,
 *   an empty collection, or an explicit `unavailableReason` -- never a zero
 *   or a guess standing in for missing data.
 *
 * Ported differences from process.py, all disclosed here because this
 * module's honesty rules mean a silent divergence would be exactly the kind
 * of thing this design forbids:
 *
 * - Timestamps are epoch-ms `number` throughout, not ISO8601 strings. The
 *   commits this module receives (`../github/commits.ts`) already convert
 *   GitHub's ISO8601 via `Date.parse`, and the portal's own DB timestamps
 *   are epoch-ms integers (`worker/db/schema.ts`), so there is no reason to
 *   round-trip through strings here. `_parse_iso8601`'s Python-3.8
 *   `Z`-suffix workaround has no TS equivalent because `Date.parse` already
 *   accepts `Z`.
 * - `historyQuality` has a fourth state, `HISTORY_FETCH_FAILED`, that
 *   process.py cannot have: process.py never talks to GitHub, so it never
 *   observes a fetch failing. This module's caller can. `fetch_failed` is
 *   produced only by `buildProcessSignals` below, never by
 *   `classifyHistoryQuality`, which stays a 3-state pure port matching
 *   Python exactly.
 * - A team with no runs yet has no way to know which stage map applies
 *   (`weekLabel` is `null`), which process.py's caller-supplied `stage_map`
 *   argument has no equivalent for: Python always assumes the caller
 *   already resolved one. When `weekLabel` is `null`, `stageFootprint` and
 *   `ownershipBreadth` degrade to `{}`, the same "we could not compute
 *   this" value Python already uses for a non-usable history -- no new
 *   sentence is needed for it, because `findingSentences`'s per-stage loops
 *   simply have no stages to iterate, which is the correct honest silence.
 * - Authorship is a set of logins per commit, not one login. process.py's
 *   `Commit.author_login` is a single string because process.py was written
 *   against `git log` output, which reports one author. GitHub's own
 *   attribution reads `Co-authored-by:` trailers too, and a 2026 team that
 *   worked in one editor session put a real student on three commits and
 *   nowhere else. Resolving a trailer to a person needs the team roster, so
 *   the roster is an input here (`RosterMember[]`) rather than something
 *   `../github/commits.ts` could have applied on its way past. See
 *   `resolveCoAuthorLogin` for what counts as a resolution and why anything
 *   else is dropped.
 * - `RunRecord.createdAt` is deliberately *not* sourced from the `runs`
 *   table's `created_at` column despite matching process.py's `Run.created_at`
 *   field name. `first_light` is about when a run finished and scored, and
 *   this portal already has an established answer for that in
 *   `worker/services/team-nudges.ts` (`lastScoredAt`): `finishedAt` on a
 *   `status = 'succeeded'` run. Using the DB's `created_at` (queue time)
 *   here would both mismatch that sibling feature and report the wrong
 *   instant. See `buildProcessSignals`'s caller in `routes/team.ts` for
 *   where this mapping happens.
 */

import type { CoAuthorTrailer, CommitRecord } from "../github/commits";
import type { FetchCommitsResult } from "../github/commits";

// ---------------------------------------------------------------------------
// History quality
// ---------------------------------------------------------------------------

export const HISTORY_USABLE = "usable" as const;
export const HISTORY_BULK_UPLOAD = "bulk_upload" as const;
export const HISTORY_EMPTY = "empty" as const;
/** TS-only; see module docstring. Never returned by `classifyHistoryQuality`. */
export const HISTORY_FETCH_FAILED = "fetch_failed" as const;

export type CommitHistoryQuality =
  | typeof HISTORY_USABLE
  | typeof HISTORY_BULK_UPLOAD
  | typeof HISTORY_EMPTY;
export type HistoryQuality = CommitHistoryQuality | typeof HISTORY_FETCH_FAILED;

/**
 * A single commit holding more than this share of all changed files across
 * the whole history is treated as a bulk upload rather than real
 * development history. 60% is the threshold given in the spec; it is not a
 * number tuned against real data, so tighten it if a bulk upload is ever
 * seen to hide below it. Matches process.py's `_BULK_UPLOAD_FILE_SHARE`.
 */
const BULK_UPLOAD_FILE_SHARE = 0.6;

/**
 * Decide whether `commits` supports per-commit attribution at all.
 *
 * Two of five real capstone teams pushed their whole project as one commit.
 * For those repositories, "which stage did this commit touch" is
 * meaningless and reporting it anyway would fabricate a history that never
 * happened. This is the single place that notices, so every commit-derived
 * signal below can call it and refuse to compute rather than guess. Direct
 * port of process.py's `classify_history_quality`.
 */
export function classifyHistoryQuality(commits: CommitRecord[]): CommitHistoryQuality {
  if (commits.length === 0) return HISTORY_EMPTY;
  if (commits.length === 1) return HISTORY_BULK_UPLOAD;
  const totalFiles = commits.reduce((sum, commit) => sum + commit.filesChanged.length, 0);
  if (totalFiles > 0) {
    const largest = Math.max(...commits.map((commit) => commit.filesChanged.length));
    if (largest / totalFiles > BULK_UPLOAD_FILE_SHARE) return HISTORY_BULK_UPLOAD;
  }
  return HISTORY_USABLE;
}

/** Direct port of process.py's `_unavailable_reason`, for the 3 states it covers. */
function unavailableReason(commits: CommitRecord[], quality: CommitHistoryQuality): string | null {
  if (quality === HISTORY_EMPTY) return "this repository has no recorded commits";
  if (quality === HISTORY_BULK_UPLOAD) {
    if (commits.length === 1) return "the entire history is a single commit";
    return "one commit holds more than 60% of all changed files, so per-commit attribution would be noise";
  }
  return null;
}

/** The reasons paired with `HISTORY_FETCH_FAILED`. TS-only; see module docstring. */
const FETCH_FAILED_REASON = "the commit history could not be read from GitHub just now";
export const UNAUTHORIZED_HISTORY_REASON =
  "GitHub no longer accepts this portal's sign-in for you, so the stages below are blank. Sign out, sign in with GitHub again, and reopen this page.";

type HistoryFetchFailureReason = Extract<FetchCommitsResult, { ok: false }>["reason"];

function historyUnavailableReason(reason: HistoryFetchFailureReason): string {
  return reason === "unauthorized" ? UNAUTHORIZED_HISTORY_REASON : FETCH_FAILED_REASON;
}

// ---------------------------------------------------------------------------
// Path matching shared by stageFootprint, ownershipBreadth, and boundaryChurn
// ---------------------------------------------------------------------------

/**
 * Translates an fnmatch-style glob (`*`, `?`, `[seq]`, `[!seq]`) into an
 * anchored RegExp. JS has no fnmatch equivalent, so this is hand-written.
 * None of the real WEEK1/2/3 stage-map patterns below contain glob
 * characters -- they are all plain substrings -- so this path is exercised
 * only if a future stage map adds one; it exists for exact semantic parity
 * with process.py's `_matches_any` rather than because current data needs it.
 */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else if (ch === "[") {
      let j = i + 1;
      let cls = "[";
      if (pattern[j] === "!") {
        cls += "^";
        j += 1;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        cls += pattern[j] === "\\" ? "\\\\" : pattern[j];
        j += 1;
      }
      cls += "]";
      out += cls;
      i = j;
    } else {
      out += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Case-insensitive match of `path` against `patterns`. Direct port of
 * process.py's `_matches_any`: a pattern containing a glob character is
 * matched against both the full path and the basename; anything else is a
 * plain substring test, which is the common case here -- stage maps below
 * are mostly bare words like `"whisper"` meant to match `whispers.py`,
 * `test_whispers.py`, and `core/whispers.py` alike.
 */
function matchesAny(path: string, patterns: string[]): boolean {
  const lowered = path.toLowerCase();
  const segments = lowered.split("/");
  const basename = segments[segments.length - 1];
  for (const raw of patterns) {
    const pattern = raw.toLowerCase();
    if (/[*?[]/.test(pattern)) {
      const regex = globToRegExp(pattern);
      if (regex.test(lowered) || regex.test(basename)) return true;
    } else if (lowered.includes(pattern)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Who a commit is by
// ---------------------------------------------------------------------------

/** One team member, as co-author resolution needs them. */
export interface RosterMember {
  login: string;
  email: string;
}

const NOREPLY_HOST = "@users.noreply.github.com";

/** `12345+ada@users.noreply.github.com` -> `ada`; `ada@users.noreply.github.com` -> `ada`. */
function loginFromNoreply(email: string): string | null {
  if (!email.endsWith(NOREPLY_HOST)) return null;
  const local = email.slice(0, -NOREPLY_HOST.length);
  const plus = local.indexOf("+");
  return (plus === -1 ? local : local.slice(plus + 1)) || null;
}

/**
 * The roster member a trailer names, or `null`.
 *
 * Three ways to resolve, in order: GitHub's own noreply address, which
 * carries the login; the address the portal already has on file for a
 * member; and the trailer's name field when it is literally a roster login,
 * which is what an editor writes when it has a login and no address.
 *
 * A trailer that matches none of them is dropped, and that single rule is
 * the whole defence against bots, AI assistants, and outside contributors
 * appearing in a team's ownership map. There is deliberately no list of
 * their names to maintain: anyone not on this team's roster is not on this
 * team's roster, whoever they are.
 *
 * The roster's own spelling of the login is returned, not the trailer's, so
 * the same person cannot appear twice under two casings.
 */
function resolveCoAuthorLogin(trailer: CoAuthorTrailer, roster: RosterMember[]): string | null {
  const email = trailer.email.toLowerCase();
  const noreplyLogin = loginFromNoreply(email);
  if (noreplyLogin) {
    const byNoreply = roster.find((member) => member.login.toLowerCase() === noreplyLogin);
    if (byNoreply) return byNoreply.login;
  }
  const byEmail = roster.find((member) => member.email.toLowerCase() === email);
  if (byEmail) return byEmail.login;
  const name = trailer.name.trim().toLowerCase();
  const byName = name ? roster.find((member) => member.login.toLowerCase() === name) : undefined;
  return byName ? byName.login : null;
}

/** Every person a commit is by: its author, plus each trailer that resolves. */
function commitAuthorLogins(commit: CommitRecord, roster: RosterMember[]): string[] {
  const logins = [commit.authorLogin];
  for (const trailer of commit.coAuthors) {
    const login = resolveCoAuthorLogin(trailer, roster);
    if (login !== null) logins.push(login);
  }
  return logins;
}

// ---------------------------------------------------------------------------
// Signal 1: stage footprint
// ---------------------------------------------------------------------------

/**
 * What was observed for one capstone stage. Direct port of process.py's
 * `StageActivity`. `commitCount` and `distinctAuthorCount` are `null`, not
 * `0`, when `available` is `false`: a `0` would read as "we looked and
 * nothing happened," a different, stronger claim than "we could not look."
 * When `available` is `true`, `0` is a real finding and is reported as such.
 */
export interface StageActivity {
  commitCount: number | null;
  distinctAuthorCount: number | null;
  firstTouchAt: number | null;
  lastTouchAt: number | null;
  available: boolean;
  unavailableReason: string | null;
}

function unavailableStageActivity(reason: string | null): StageActivity {
  return {
    commitCount: null,
    distinctAuthorCount: null,
    firstTouchAt: null,
    lastTouchAt: null,
    available: false,
    unavailableReason: reason,
  };
}

function degradedStageMap(
  stageMap: Record<string, string[]>,
  reason: string | null,
): Record<string, StageActivity> {
  const result: Record<string, StageActivity> = {};
  for (const stage of Object.keys(stageMap)) result[stage] = unavailableStageActivity(reason);
  return result;
}

/**
 * Attribute commits to capstone stages by the files they touch.
 *
 * A commit that touches files in several stages is counted for each one;
 * there is no single-winner rule, because an integration commit that wires
 * the database to the query stage genuinely belongs to both, and forcing a
 * single label would hide exactly the cross-stage work this signal exists
 * to surface. Direct port of process.py's `stage_footprint`.
 */
export function stageFootprint(
  commits: CommitRecord[],
  stageMap: Record<string, string[]>,
  roster: RosterMember[],
): Record<string, StageActivity> {
  const quality = classifyHistoryQuality(commits);
  if (quality !== HISTORY_USABLE) {
    return degradedStageMap(stageMap, unavailableReason(commits, quality));
  }

  const result: Record<string, StageActivity> = {};
  for (const [stage, patterns] of Object.entries(stageMap)) {
    let commitCount = 0;
    const authors = new Set<string>();
    let firstTouchAt: number | null = null;
    let lastTouchAt: number | null = null;
    for (const commit of commits) {
      if (!commit.filesChanged.some((path) => matchesAny(path, patterns))) continue;
      commitCount += 1;
      for (const login of commitAuthorLogins(commit, roster)) authors.add(login);
      if (firstTouchAt === null || commit.authoredAt < firstTouchAt) firstTouchAt = commit.authoredAt;
      if (lastTouchAt === null || commit.authoredAt > lastTouchAt) lastTouchAt = commit.authoredAt;
    }
    result[stage] = {
      commitCount,
      distinctAuthorCount: authors.size,
      firstTouchAt,
      lastTouchAt,
      available: true,
      unavailableReason: null,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Signal 2: first light
// ---------------------------------------------------------------------------

/**
 * One portal run, as `firstLight` needs it. Runs are the portal's own
 * observation, not supplementary evidence with gaps the way commits are, so
 * `firstLight` never checks history quality the way the commit-derived
 * signals do -- a bulk-uploaded repository can still have run history, and
 * that history is exactly as trustworthy as any other team's. See the
 * module docstring for where `createdAt`'s value actually comes from.
 */
export interface RunRecord {
  runId: string;
  createdAt: number;
  scored: boolean;
}

/**
 * The integration instrument. `firstScoredAt` is `null` when the team has
 * never had a run make it all the way through scoring -- the state the
 * instructor called out as the single most useful thing to know about a
 * team mid-week. Direct port of process.py's `FirstLight`.
 */
export interface FirstLightSignal {
  firstScoredAt: number | null;
  scoredRunCount: number;
}

/** Direct port of process.py's `first_light`. */
export function firstLight(runs: RunRecord[]): FirstLightSignal {
  const scored = runs.filter((run) => run.scored);
  if (scored.length === 0) return { firstScoredAt: null, scoredRunCount: 0 };
  const earliest = scored.reduce((min, run) => (run.createdAt < min.createdAt ? run : min));
  return { firstScoredAt: earliest.createdAt, scoredRunCount: scored.length };
}

// ---------------------------------------------------------------------------
// Signal 3: boundary churn
// ---------------------------------------------------------------------------

/**
 * A commit that touched a contract file after first light. `files` lists
 * which boundary files were touched, not how many lines changed in them --
 * a signature edit and a docstring edit both touch the file, and this
 * signal is about the fact of the touch, not its size. Direct port of
 * process.py's `ChurnEvent`.
 */
export interface ChurnEvent {
  sha: string;
  authorLogin: string;
  authoredAt: number;
  files: string[];
}

/**
 * Commits that touched a contract file after the team's first scored run.
 *
 * Before first light, a signature change is ordinary design work: the team
 * has not agreed on an interface yet, because nothing has proven the pieces
 * fit together. `firstLightAt === null` means the team has no first light
 * to measure churn against, so the honest answer is "nothing to report"
 * (`[]`), not "everything counts." Direct port of process.py's
 * `boundary_churn`.
 */
export function boundaryChurn(
  commits: CommitRecord[],
  boundaryFiles: string[],
  firstLightAt: number | null,
): ChurnEvent[] {
  if (firstLightAt === null) return [];
  if (classifyHistoryQuality(commits) !== HISTORY_USABLE) return [];

  const ordered = [...commits].sort((a, b) => a.authoredAt - b.authoredAt);
  const events: ChurnEvent[] = [];
  for (const commit of ordered) {
    const touched = commit.filesChanged.filter((path) => matchesAny(path, boundaryFiles)).sort();
    if (touched.length === 0) continue;
    if (commit.authoredAt > firstLightAt) {
      events.push({
        sha: commit.sha,
        authorLogin: commit.authorLogin,
        authoredAt: commit.authoredAt,
        files: touched,
      });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Signal 4: ownership breadth
// ---------------------------------------------------------------------------

/**
 * Distinct author logins per stage: a bus-factor map, not a leaderboard.
 *
 * Deliberately a list of names with no counts attached anywhere, per stage.
 * "Which stages has only one person ever touched" is the question this
 * answers; "how much did each person do" is a question this module refuses
 * to answer, in this function or any other -- see the module docstring and
 * the no-per-person-fields guardrail test.
 *
 * Returns `{}`, not per-stage empty lists, when the commit history is not
 * usable: an empty object is unambiguous evidence of "nothing was
 * computed," where an object of empty arrays could be misread as "computed,
 * and no one touched any stage." Direct port of process.py's
 * `ownership_breadth`.
 */
export function ownershipBreadth(
  commits: CommitRecord[],
  stageMap: Record<string, string[]>,
  roster: RosterMember[],
): Record<string, string[]> {
  if (classifyHistoryQuality(commits) !== HISTORY_USABLE) return {};

  const result: Record<string, string[]> = {};
  for (const [stage, patterns] of Object.entries(stageMap)) {
    const authors = new Set<string>();
    for (const commit of commits) {
      if (!commit.filesChanged.some((path) => matchesAny(path, patterns))) continue;
      for (const login of commitAuthorLogins(commit, roster)) authors.add(login);
    }
    result[stage] = Array.from(authors).sort();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Finding sentences
// ---------------------------------------------------------------------------

export type WeekLabel = "week1" | "week2" | "week3";

/** The four signals bundled together, for handing to `findingSentences`. */
export interface ProcessSignals {
  historyQuality: HistoryQuality;
  /**
   * The team has scored runs, and none of them is evidence for the repository
   * connected now. TS-only; not persisted, and not in the contract.
   */
  runsElsewhere: boolean;
  /** Internal fetch detail. The contracts schema keeps `historyQuality` at `fetch_failed`. */
  historyFetchFailureReason: HistoryFetchFailureReason | null;
  stageFootprint: Record<string, StageActivity>;
  firstLight: FirstLightSignal;
  boundaryChurn: ChurnEvent[];
  ownershipBreadth: Record<string, string[]>;
  /** TS-only; see module docstring. `null` when the team has no runs yet. */
  weekLabel: WeekLabel | null;
}

/** Epoch ms -> `YYYY-MM-DD` (UTC), matching process.py's `_format_date` (`.date().isoformat()`). */
function formatDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Stage names as prose: `["peaks"]` -> `"the peaks stage"`, `["peaks",
 * "fanout"]` -> `"the peaks and fanout stages"`. The conjunction is a
 * parameter because a negative sentence ("no commit has touched X or Y")
 * and a positive one ("one person has committed to X and Y") need
 * different ones to mean the same thing.
 */
function stagePhrase(stages: string[], conjunction: "and" | "or"): string {
  const noun = stages.length === 1 ? "stage" : "stages";
  if (stages.length === 1) return `the ${stages[0]} ${noun}`;
  if (stages.length === 2) return `the ${stages[0]} ${conjunction} ${stages[1]} ${noun}`;
  const last = stages[stages.length - 1];
  return `the ${stages.slice(0, -1).join(", ")}, ${conjunction} ${last} ${noun}`;
}

/**
 * The ceiling on how many sentences a team can be shown at once.
 *
 * The assembly below cannot exceed it today: the history caveat and the two
 * coverage sentences are mutually exclusive (a history the caveat is about
 * leaves `stageFootprint` unavailable and `ownershipBreadth` empty), so the
 * longest real list is first light, contract churn, untouched stages, and
 * single-author stages. The slice is here for whoever adds a fifth, because
 * "a wall of sentences" is the failure this panel already had once.
 */
const MAX_FINDING_SENTENCES = 4;

/** What happened to the pipeline: the history we could read, the first run
 *  that scored, and whether the benchmark's own entry points moved after it. */
function pipelineSentences(signals: ProcessSignals): string[] {
  const sentences: string[] = [];

  if (signals.historyQuality === HISTORY_BULK_UPLOAD) {
    sentences.push(
      "The repository arrived as one upload, so there is no way to tell which commit touched which stage; the runs are the portal's own record and still hold.",
    );
  } else if (signals.historyQuality === HISTORY_EMPTY) {
    sentences.push(
      "There is no commit history yet, so there is nothing to read about which parts of the pipeline have been worked on.",
    );
  } else if (signals.historyQuality === HISTORY_FETCH_FAILED) {
    sentences.push(
      signals.historyFetchFailureReason === "unauthorized"
        ? UNAUTHORIZED_HISTORY_REASON
        : "The commit history could not be read from GitHub just now, so the stages below are blank; the runs are the portal's own record and still hold.",
    );
    // Two branches on one fact. `historyUnavailableReason` above picks the
    // per-stage wording from the same reason; keep them together if either
    // sentence changes.
  }

  if (signals.firstLight.firstScoredAt === null) {
    // Two different states, and they used to read as one. A team that scored
    // five times on the repository they just disconnected was told "No run has
    // scored end to end yet", which reads as the portal losing their work. The
    // runs are still there; they are evidence for a different repository, or
    // (before migration 0013) for one nothing recorded. Either way they cannot
    // speak for this one, and saying that is both true and useful.
    sentences.push(
      signals.runsElsewhere
        ? "Your earlier scored runs aren't tied to the repository that's connected now, so the stage map starts again with your next run."
        : "No run has scored end to end yet, so there is no working pipeline to read anything else against. Integration is the part the course says is hardest, and it usually takes longer than teams expect.",
    );
  } else {
    const date = formatDate(signals.firstLight.firstScoredAt);
    // `scoredRunCount` counts every scored run including the first, so "since"
    // would be off by one. Say "in total" and it is exactly what was counted.
    sentences.push(
      signals.firstLight.scoredRunCount === 1
        ? `Your pipeline first scored end to end on ${date}, and that is still the only run that has scored.`
        : `Your pipeline first scored end to end on ${date}, and ${signals.firstLight.scoredRunCount} runs have scored in total.`,
    );
  }

  // One sentence for the whole set, not one per file. Per-file sentences
  // were both a wall and an overclaim: `boundaryChurn.files` records that a
  // file was touched, never what changed inside it, so naming a signature
  // change was a claim the signal cannot support.
  const churned = signals.boundaryChurn.length;
  if (churned > 0) {
    sentences.push(
      `${churned} commit${churned === 1 ? " has" : "s have"} changed the files the benchmark calls since that run, so a run that passed before can stop passing.`,
    );
  }

  return sentences;
}

/** Who has worked where, as two whole-team readings rather than one line per
 *  stage. Both are stage-wide, which is the only shape this module allows:
 *  see the no-per-person rule in the module docstring. */
function coverageSentences(signals: ProcessSignals): string[] {
  const sentences: string[] = [];

  const untouched = Object.keys(signals.stageFootprint)
    .filter((stage) => {
      const activity = signals.stageFootprint[stage];
      return activity.available && activity.commitCount === 0;
    })
    .sort();
  if (untouched.length > 0) {
    sentences.push(
      `No commit has touched ${stagePhrase(untouched, "or")} yet, so that work either hasn't started or lives in files the portal doesn't read as that stage.`,
    );
  }

  // A stage with no commits has no authors either, so it is already covered
  // by the sentence above and cannot appear here as well.
  const solo = Object.keys(signals.ownershipBreadth)
    .filter((stage) => signals.ownershipBreadth[stage].length === 1)
    .sort();
  if (solo.length > 0) {
    sentences.push(
      `Only one person has committed to ${stagePhrase(solo, "and")}, so if they get stuck, nobody else has been inside that code.`,
    );
  }

  return sentences;
}

/**
 * Template-assembled sentences describing `signals`, in the course's
 * register, in two groups: what happened to the pipeline, then who has
 * worked where.
 *
 * Every sentence here is a fixed template selected by a condition on the
 * data; nothing is generated. That is a hard requirement, not a style
 * preference: a wrong generated claim about which teammate did what is
 * socially expensive to a team of seventeen-year-olds in a way a wrong
 * number is not (see `docs/design/the-instrument-not-the-judge.md`, "What
 * this forbids").
 *
 * Two things changed from process.py's `finding_sentences`, both because
 * students read the first version on the deployed site and could not tell
 * what it was for:
 *
 * - Each sentence now states its consequence, not only its observation.
 *   "Only one person has touched the descriptors stage" is a fact with no
 *   reason to care attached; a reader has to already know why a bus factor
 *   of one matters before the sentence means anything.
 * - The per-stage and per-file loops are gone. They emitted one sentence per
 *   stage and one per contract file, which on a real team was seven lines of
 *   near-identical prose above a stage list that said the same thing again.
 *   Each is now a single sentence naming every stage it covers, so the list
 *   cannot grow with the repository. `MAX_FINDING_SENTENCES` is the backstop.
 *
 * The `HISTORY_FETCH_FAILED` sentence remains TS-only; Python cannot produce
 * that state (see module docstring).
 */
export function findingSentences(signals: ProcessSignals): string[] {
  return [...pipelineSentences(signals), ...coverageSentences(signals)].slice(
    0,
    MAX_FINDING_SENTENCES,
  );
}

// ---------------------------------------------------------------------------
// Default stage maps
// ---------------------------------------------------------------------------
//
// Duplicated from python/cogbench/src/cogbench/process.py's WEEK1_STAGE_MAP,
// WEEK2_STAGE_MAP, WEEK3_STAGE_MAP, and DEFAULT_STAGE_MAPS. The Worker
// cannot import a Python module, so these are copied verbatim rather than
// shared; keep them in sync by hand if process.py's stage maps change.
// Patterns are bare word roots, matched as case-insensitive substrings by
// `matchesAny`, so `"peak"` matches `find_peaks.py`, `PeakFinding.ipynb`,
// and `test_peak_params.py` alike. Chosen against the course's own stage
// names and checked against file names actually used across real team
// repositories -- see process.py's comment above `WEEK1_STAGE_MAP` for the
// full provenance note.

export const WEEK1_STAGE_MAP: Record<string, string[]> = {
  spectrogram: ["spectrogram", "spectogram", "stft"],
  peaks: ["peak", "local_max", "localmax", "find_peaks"],
  fanout: ["fanout", "fan_out", "fingerprint"],
  database: ["database", "song_metadata", "builddb", "build_database"],
  query: ["quer", "match", "recogni", "retriev", "rerank", "identify"],
};

export const WEEK2_STAGE_MAP: Record<string, string[]> = {
  descriptors: ["descriptor", "facenet"],
  profiles: ["profile", "database", "vector_db", "builddb", "adddatabase"],
  matching: ["match", "similarity", "threshold", "recogni", "distance", "cutoff"],
  whispers: ["whisper", "cluster", "graph"],
};

export const WEEK3_STAGE_MAP: Record<string, string[]> = {
  organizer: ["organiz", "coco", "idconversion"],
  embedding: ["embed", "descriptor", "caption"],
  training: ["train", "triplet", "margin_rank", "valid"],
  search: ["search", "quer", "image_query", "text_to_image", "database"],
};

/** Convenience lookup from a week label to its default stage map. */
export const DEFAULT_STAGE_MAPS: Record<WeekLabel, Record<string, string[]>> = {
  week1: WEEK1_STAGE_MAP,
  week2: WEEK2_STAGE_MAP,
  week3: WEEK3_STAGE_MAP,
};

/**
 * Duplicated from python/cogbench/src/cogbench/apploader.py's
 * `CANDIDATE_FILENAMES` -- the real contract-file list a submission is
 * loaded against. Deliberately NOT process.py's own test-only fixture
 * (`["contract.py"]`), which appears only inside `test_process.py`'s
 * `BoundaryChurnTests` and is not a real boundary file in this repository.
 */
export const BOUNDARY_FILES = ["submission.py", "benchmark_adapter.py"];

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface BuildProcessSignalsInput {
  commitsResult: FetchCommitsResult;
  runs: RunRecord[];
  /** See `ProcessSignals.runsElsewhere`. Defaults to false. */
  runsElsewhere?: boolean;
  weekLabel: WeekLabel | null;
  /** The team, for resolving `Co-authored-by:` trailers. An empty roster
   *  resolves nothing, which is the honest reading of "we don't know who
   *  these people are" rather than a reason to guess. */
  roster: RosterMember[];
}

/**
 * Assembles `ProcessSignals` from a commit fetch result, a team's runs, and
 * their resolved week label.
 *
 * process.py has no equivalent of this function: every pure signal above is
 * a near-exact port of one of its functions, but process.py's caller is
 * assumed to have already fetched commits successfully and resolved a
 * stage map, neither of which is true here. This function exists only to
 * handle the two states the pure ports cannot express on their own --
 * `!commitsResult.ok` (the fetch failed) and `weekLabel === null` (the team
 * has no runs yet, so no stage map is knowable) -- before delegating to the
 * ported functions for everything else. See the module docstring for both.
 */
export function buildProcessSignals(input: BuildProcessSignalsInput): ProcessSignals {
  const light = firstLight(input.runs);
  const stageMap = input.weekLabel ? DEFAULT_STAGE_MAPS[input.weekLabel] : null;

  if (!input.commitsResult.ok) {
    return {
      historyQuality: HISTORY_FETCH_FAILED,
      runsElsewhere: input.runsElsewhere ?? false,
      historyFetchFailureReason: input.commitsResult.reason,
      stageFootprint: stageMap
        ? degradedStageMap(stageMap, historyUnavailableReason(input.commitsResult.reason))
        : {},
      firstLight: light,
      boundaryChurn: [],
      ownershipBreadth: {},
      weekLabel: input.weekLabel,
    };
  }

  const commits = input.commitsResult.commits;
  return {
    historyQuality: classifyHistoryQuality(commits),
    runsElsewhere: input.runsElsewhere ?? false,
    historyFetchFailureReason: null,
    stageFootprint: stageMap ? stageFootprint(commits, stageMap, input.roster) : {},
    firstLight: light,
    boundaryChurn: boundaryChurn(commits, BOUNDARY_FILES, light.firstScoredAt),
    ownershipBreadth: stageMap ? ownershipBreadth(commits, stageMap, input.roster) : {},
    weekLabel: input.weekLabel,
  };
}
