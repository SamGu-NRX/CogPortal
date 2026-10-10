/**
 * TypeScript-arm adapter for the process-signals study.
 *
 * Reads one neutral fixture JSON (a scenario from the frozen manifest, with
 * its roster), runs it through the real
 * `apps/portal/worker/services/process-signals.ts` builder, and writes the
 * canonical result JSON to the output path given as argv[1]. Run via:
 *
 *   pnpm exec tsx experiments/process-signals/run-worker.ts <fixture.json> <out.json>
 *
 * This adapter is plumbing, not a copy of the builder: it only decodes the
 * neutral fixture into the shapes `buildProcessSignals` consumes (ISO strings
 * -> epoch ms, `createdAt` -> `finishedAt`, both mappings disclosed in
 * FIELDS.md and the manifest encoding block) and serializes its output. The
 * week -> stage-map lookup is the TS orchestrator's own `DEFAULT_STAGE_MAPS`,
 * imported directly so no stage map is ever mirrored by hand.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { buildProcessSignals, DEFAULT_STAGE_MAPS } from "../../apps/portal/worker/services/process-signals";

interface NeutralCommit {
  sha: string;
  authorLogin: string;
  authoredAt: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  coAuthors: { name: string; email: string }[];
}

interface Fixture {
  scenario: {
    id: string;
    week: string | null;
    truncated: boolean;
    fetchFailure?: { ok: false; reason: string };
    commits: NeutralCommit[];
    runs: { runId: string; createdAt: string; status: string; scored: boolean }[];
  };
  roster: { login: string; email: string }[];
}

const fixturePath = process.argv[2];
const outPath = process.argv[3];
if (!fixturePath || !outPath) {
  console.error("usage: tsx run-worker.ts <fixture.json> <out.json>");
  process.exit(2);
}

const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const resolvedStageMap: Record<string, string[]> | null = fixture.scenario.week
  ? (DEFAULT_STAGE_MAPS as Record<string, Record<string, string[]>>)[fixture.scenario.week]
  : null;

const commitsResult = fixture.scenario.fetchFailure
  ? ({ ok: false, reason: fixture.scenario.fetchFailure.reason } as const)
  : ({
      ok: true,
      truncated: fixture.scenario.truncated,
      commits: fixture.scenario.commits.map((commit) => ({
        sha: commit.sha,
        authorLogin: commit.authorLogin,
        authoredAt: Date.parse(commit.authoredAt),
        filesChanged: [...commit.filesChanged],
        coAuthors: commit.coAuthors.map((trailer) => ({ name: trailer.name, email: trailer.email })),
      })),
    } as const);

const signals = buildProcessSignals({
  commitsResult,
  runs: fixture.scenario.runs.map((run) => ({
    runId: run.runId,
    finishedAt: Date.parse(run.createdAt),
    scored: run.scored,
  })),
  weekLabel: fixture.scenario.week as "week1" | "week2" | "week3" | null,
  roster: fixture.roster.map((member) => ({ login: member.login, email: member.email })),
});

// Canonical shape, byte-comparable with the Python arm's normalization.
const canonical = {
  historyQuality: signals.historyQuality,
  stageFootprint: Object.fromEntries(
    Object.entries(signals.stageFootprint).map(([stage, activity]) => [
      stage,
      {
        commitCount: activity.commitCount,
        distinctAuthorCount: activity.distinctAuthorCount,
        firstTouchAtMs: activity.firstTouchAt,
        lastTouchAtMs: activity.lastTouchAt,
        available: activity.available,
        unavailableReason: activity.unavailableReason,
      },
    ]),
  ),
  firstLight: {
    firstScoredAtMs: signals.firstLight.firstScoredAt,
    scoredRunCount: signals.firstLight.scoredRunCount,
  },
  boundaryChurn: signals.boundaryChurn.map((event) => ({
    sha: event.sha,
    authorLogin: event.authorLogin,
    authoredAtMs: event.authoredAt,
    files: event.files,
  })),
  ownershipBreadth: signals.ownershipBreadth,
  windowCommits: signals.historyWindow?.commits ?? null,
  tsOnly: {
    historyWindow: signals.historyWindow,
    runsElsewhere: signals.runsElsewhere,
    historyFetchFailureReason: signals.historyFetchFailureReason,
    weekLabel: signals.weekLabel,
    stageMapResolved: resolvedStageMap ? Object.keys(resolvedStageMap) : null,
  },
};

writeFileSync(outPath, JSON.stringify(canonical, null, 2) + "\n");
