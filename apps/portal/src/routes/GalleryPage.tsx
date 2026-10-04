import { CopyBlock } from "@/components/CopyBlock";
import { FailureCard } from "@/components/FailureCard";
import { Step, StepRail } from "@/components/StepRail";
import { Finding, FINDING_KICKER } from "@/components/Finding";
import { ConnectGate } from "@/components/ConnectGate";
import { Panel } from "@/components/Panel";
import { PrimaryMetric, SupportingMetrics } from "@/components/MetricBlock";
import { SweepTrace } from "@/components/SweepTrace";
import { WiringTrace, type WiredStep } from "@/components/WiringTrace";
import { RunList } from "@/components/RunList";
import { RunConsole } from "@/components/RunConsole";
import { LocalReportsTable } from "@/components/LocalReportsTable";
import { HeldDeviceLinkCard } from "@/components/HeldDeviceLinkOffer";
import { setupCommandLines, stepState } from "@/lib/setup-progress";
import type { GateOutcome, GatePhase, GateVariant } from "@/lib/activity-gate";
import {
  LocalReportSchema,
  RunSurfaceSnapshotSchema,
  RunSummarySchema,
  type LeaderboardEntry,
  type LocalReport,
  type Metric,
  type RunDetail as RunDetailType,
} from "@cogworks/contracts/schema";
import { BoardContext, PublishedGallery } from "./LeaderboardPage";
import { benchmarkScopeLine } from "@/lib/published-results";

/**
 * Every state of the surfaces that are hard to reach, on one page.
 *
 * Some of these need a scored run against a specific failure, and producing
 * one on demand means either faking database rows or waiting for a team to
 * break their code in the right way. Neither is a reasonable way to look at a
 * sentence and decide whether it reads well.
 *
 * Dev only: the route is registered behind `import.meta.env.DEV`, so it does
 * not exist in a deployed bundle. The fixtures are hand-written rather than
 * generated, because the point is to look at the wording.
 */

function metric(over: Partial<Metric> = {}): Metric {
  return {
    key: "identification_score",
    label: "Identification score",
    value: 0.5312,
    precision: 4,
    unit: null,
    primary: true,
    higherIsBetter: true,
    help:
      "Top-1 accuracy over clips cut from songs you enrolled, after " +
      "perturbation. This is the leaderboard number.",
    ...over,
  } as Metric;
}

/* Public board entries, sent in the read model's score order on purpose: the
 * gallery should show them newest first anyway. Invented teams and numbers.
 * Covers every metric role, a run with no recorded roles, an archive row, a
 * team with no line, and a long name and line that must wrap at 390px. */
const GALLERY_BOARD_NOW = 1_791_000_000_000;
const BOARD_TICKS = [
  { x: 0, label: "verbatim" },
  { x: 1, label: "keywords" },
  { x: 2, label: "truncated" },
  { x: 3, label: "typo" },
];
const boardCurve = (...ys: Array<number | null>): LeaderboardEntry["publicSweep"] => ({
  axis: "query variant",
  metric: "Search MRR",
  ticks: BOARD_TICKS,
  points: ys.flatMap((y, x) => (y === null ? [] : [{ x, y }])),
});
const BOARD_METRIC = (key: string, label: string, value: number, role: Metric["role"]) =>
  metric({ key, label, value, role, primary: false, precision: key === "median_rank" ? 0 : 3, help: null });
const BOARD_ENTRIES: LeaderboardEntry[] = [
  {
    rank: 1, teamName: "Lantern Lab", provenance: "live", isYou: false,
    teamDescription: "Caption embeddings averaged over GloVe, with stopwords dropped before weighting.",
    repoUrl: "https://github.com/cogworks-fixture/lantern-lab", sha: "a1".repeat(20), shortSha: "a1a1a1a",
    primaryMetric: metric({ key: "overall", label: "Overall", value: 0.512, precision: 4, role: "scored", help: null }),
    supportingMetrics: [
      BOARD_METRIC("chance_mrr", "Chance MRR", 0.013, "floor"),
      BOARD_METRIC("text_mrr", "Text MRR", 0.881, "scored"),
      BOARD_METRIC("retrieval_mrr", "Retrieval MRR", 0.394, "scored"),
      BOARD_METRIC("search_mrr_verbatim", "Search MRR, caption unchanged (not scored)", 0.641, "reported"),
      BOARD_METRIC("search_mrr_keywords", "Search MRR, keywords only", 0.573, "plotted"),
      BOARD_METRIC("search_mrr_typo", "Search MRR, one typo", 0.51, "plotted"),
      BOARD_METRIC("median_rank", "Median rank", 4, "diagnostic"),
    ],
    completedAt: GALLERY_BOARD_NOW - 2 * 86_400_000,
    publicSweep: boardCurve(0.6412, 0.5733, 0.4021, 0.5104),
  },
  {
    rank: 2, teamName: "Team Heron", provenance: "archive", isYou: false,
    teamDescription: "Learned a linear map from captions to image features.",
    repoUrl: null, sha: "", shortSha: "",
    primaryMetric: metric({ key: "overall", label: "Overall", value: 0.48, precision: 4, role: "scored", help: null }),
    supportingMetrics: [BOARD_METRIC("text_mrr", "Text MRR", 0.86, "scored")],
    completedAt: GALLERY_BOARD_NOW - 58 * 86_400_000,
    // A text-matching submission: near the top verbatim, near the floor after.
    publicSweep: boardCurve(0.952, 0.0279, 0.031, 0.044),
  },
  {
    rank: 3, teamName: "The Extremely Thorough Retrieval Reading Group of Section B", provenance: "live", isYou: false,
    teamDescription:
      "We tried three ways of pooling word vectors and kept the plainest one, because it was the only one whose failures we could explain to each other on Thursday.",
    repoUrl: null, sha: "c3".repeat(20), shortSha: "c3c3c3c",
    primaryMetric: metric({ key: "overall", label: "Overall", value: 0.447, precision: 4, role: null, help: null }),
    supportingMetrics: [
      BOARD_METRIC("text_mrr", "Text MRR", 0.802, null),
      BOARD_METRIC("retrieval_mrr", "Retrieval MRR", 0.331, null),
    ],
    completedAt: GALLERY_BOARD_NOW - 3 * 3_600_000,
    // The typo variant was never measured; the axis still has room for it.
    publicSweep: boardCurve(0.55, 0.52, 0.47, null),
  },
  {
    rank: 4, teamName: "Quiet Hours", provenance: "live", isYou: false, teamDescription: null,
    repoUrl: "https://github.com/cogworks-fixture/quiet-hours", sha: "e5".repeat(20), shortSha: "e5e5e5e",
    primaryMetric: metric({ key: "overall", label: "Overall", value: 0.402, precision: 4, role: "scored", help: null }),
    supportingMetrics: [],
    completedAt: GALLERY_BOARD_NOW - 5 * 86_400_000,
    publicSweep: null,
  },
];

const SUPPORTING: Metric[] = [
  metric({ key: "clean_top1", label: "Clean top-1", value: 1.0, primary: false, help: null }),
  metric({ key: "noisy_top1", label: "Noisy top-1", value: 1.0, primary: false, help: null }),
  metric({
    key: "pitch_top1",
    label: "Pitch-shifted top-1",
    value: 0.0625,
    primary: false,
    help:
      "NOT part of the assignment. A shifted clip moves every peak to a " +
      "different frequency bin, so the stored keys stop matching.",
  }),
  metric({
    key: "catalog_knee",
    label: "Library size at the knee",
    value: 20,
    precision: 0,
    primary: false,
    help: "The library size where identification first drops 15 points below its best.",
  }),
];

const CASES: { title: string; note: string; sentence: string; supporting: string[] }[] = [
  {
    title: "The vote gives way",
    note: "The common shape. Fingerprints are fine, the tally is not.",
    sentence:
      "Identification holds to a 20-song library, then falls off. The right song " +
      "is still being found, so the vote is what gives way as the library grows.",
    supporting: [
      "20% of queries had the right song somewhere in the list but not near the top.",
      "Every clip from a song that was never enrolled still came back with a candidate.",
      "Weakest cell: pitch_-2 at 0% top-1.",
    ],
  },
  {
    title: "The fingerprints give way",
    note: "Different half of the pipeline, different fix.",
    sentence:
      "Identification holds to a 40-song library, then falls off, and at that " +
      "point most queries find no matching fingerprints at all. That is the " +
      "fingerprints rather than the vote.",
    supporting: [
      "94% of clips shared no fingerprints with anything the database stored.",
    ],
  },
  {
    title: "Nothing is size-limited",
    note: "The good answer. No knee metric is reported at all.",
    sentence:
      "Identification holds steady from 5 songs to 30, so nothing in the " +
      "pipeline is size-limited over this range.",
    supporting: [],
  },
  {
    title: "One note only",
    note: "Nothing below the rule. The figure must not leave a dangling border.",
    sentence:
      "Identification falls gradually from 60% at 5 songs to 52% at 30, without " +
      "a single point where it breaks.",
    supporting: [],
  },
  {
    title: "A long sentence",
    note: "Checks the 58ch measure holds and does not run to the window edge.",
    sentence:
      "Every clip from a song that was never enrolled still came back with a " +
      "candidate, and nothing in the assignment required an abstain path, so " +
      "this does not affect the score, but a minimum tally or a first-to-second " +
      "ratio is what would give you one.",
    supporting: ["A second note, for the rule.", "And a third."],
  },
];

const SWEEPS: { title: string; note: string; sweep: NonNullable<RunDetailType["sweep"]> }[] = [
  {
    title: "A knee",
    note: "Holds, then breaks. The shape the course's own method is looking for.",
    sweep: {
      axis: "songs in the library",
      metric: "identification_score",
      points: [
        { x: 5, y: 0.9 },
        { x: 10, y: 0.88 },
        { x: 20, y: 0.85 },
        { x: 40, y: 0.42 },
        { x: 80, y: 0.21 },
      ],
    },
  },
  {
    title: "The measured reference",
    note: "Real numbers from the Week 1 reference on the 30-song tier. A gentle slope, no knee.",
    sweep: {
      axis: "songs in the library",
      metric: "identification_score",
      points: [
        { x: 5, y: 0.6 },
        { x: 10, y: 0.5625 },
        { x: 20, y: 0.5312 },
        { x: 30, y: 0.5208 },
      ],
    },
  },
  {
    title: "Flat at zero",
    note: "Nothing worked. The trace must not imply a trend; the axis stays pinned to 0..1.",
    sweep: {
      axis: "songs in the library",
      metric: "identification_score",
      points: [
        { x: 5, y: 0 },
        { x: 30, y: 0 },
      ],
    },
  },
  {
    title: "Two points",
    note: "The minimum. Fewer than two returns null and draws nothing.",
    sweep: {
      axis: "captions per image",
      metric: "overall",
      points: [
        { x: 1, y: 0.71 },
        { x: 5, y: 0.44 },
      ],
    },
  },
];


/**
 * A wiring trace at the length the contract allows.
 *
 * The identifier field is capped at 200 characters, and this component used to
 * put `truncate` on it, so the end of a long one was elided with no way to see
 * it. Identifiers are the entire payload here: a team reads this to check we
 * ran the function they think we ran, and the half that gets cut is the
 * function name. There is no run in any fixture database with a name this long,
 * so this is the only way to look at it.
 */
const LONG_WIRING: WiredStep[] = [
  {
    stage: "spectrogram",
    function: "audio.processing.spectrogram_utilities.make_spectrogram_with_hann_window_and_overlap",
    received: "an array of shape (132300,), 44100",
    returned: "a tuple of 3, starting with an array of shape (2049, 63)",
  },
  {
    stage: "peaks",
    // 200 characters, at or near the 200 cap in
    // packages/contracts/src/protocol.ts. Long, and a real shape: this is what
    // a deeply namespaced repository looks like.
    function:
      "fingerprinting.peak_detection.local_maxima.find_peaks_by_iterative_neighbourho" +
      "od_comparison_over_the_log_spectrogram_with_an_amplitude_floor_and_a_minimum_time_frequency_separation_between_accepted_in",
    received: "an array of shape (2049, 63)",
    returned: "an array of shape (355, 2)",
  },
  {
    stage: "fanout",
    function: "fingerprinting.make_fgp",
    received: "an array of shape (355, 2)",
    returned: "a list of 5158, starting ((221, 468, 1), 0)",
  },
];

/** A floor whose parent is not in the list beside it. Week 3 publishes this
 *  shape whenever the image side is unmeasured, and the run page also lifts
 *  the primary metric out before rendering the rest, so a floor attached to
 *  the primary arrives here with nothing to attach to. */
const ORPHAN_FLOOR: Metric[] = [
  metric({
    key: "chance_mrr",
    label: "Chance MRR",
    value: 0.0102,
    precision: 3,
    primary: false,
    role: "floor",
    relatesTo: "retrieval_mrr",
    help: "What ranking at random scores on this pool.",
  }),
];

const PAIRED_FLOOR: Metric[] = [
  metric({
    key: "retrieval_mrr",
    label: "Retrieval MRR",
    value: 0.2586,
    precision: 3,
    primary: false,
    role: "scored",
    help: null,
  }),
  ...ORPHAN_FLOOR,
];

/** What week 3 publishes when the image side is unmeasured: a scored text
 *  metric, its floor, and a floor whose parent is not here at all. */
const WITHHELD: Metric[] = [
  metric({
    key: "text_mrr",
    label: "Text MRR",
    value: 0.7888,
    precision: 3,
    primary: false,
    role: "scored",
    help: null,
  }),
  metric({
    key: "text_chance",
    label: "Text chance MRR",
    value: 0.04,
    precision: 3,
    primary: false,
    role: "floor",
    relatesTo: "text_mrr",
    help: "What ranking at random scores on the caption pool.",
  }),
  metric({
    key: "chance_mrr",
    label: "Chance MRR",
    value: 0.0102,
    precision: 3,
    primary: false,
    role: "floor",
    relatesTo: "retrieval_mrr",
    help: "What ranking at random scores on the image pool.",
  }),
];

const SETUP_BENCHMARK_ID = "audio-identification";

const SETUP_LINES = setupCommandLines({
  cloneUrl: "https://github.com/cogworks-demo/face-finder.git",
  repoName: "face-finder",
  benchmarkId: SETUP_BENCHMARK_ID,
  benchmarkTitle: "Audio",
  portalOrigin: "https://cogportal.example",
  verified: () => true,
  deviceLinked: true,
});

/** The same rail with nothing observed and everything checked off by hand,
 *  which needs a signing secret and a terminal to reach for real. */
const SETUP_LINES_SELF_CHECKED = setupCommandLines({
  cloneUrl: "https://github.com/cogworks-demo/face-finder.git",
  repoName: "face-finder",
  benchmarkId: SETUP_BENCHMARK_ID,
  benchmarkTitle: "Audio",
  portalOrigin: "https://cogportal.example",
  verified: () => false,
  selfChecked: () => true,
  deviceLinked: false,
});

/** The page's own rail, so a layout bug here is a layout bug there. */
function SetupRailFixture({
  unreadable = false,
  lines = SETUP_LINES,
}: {
  unreadable?: boolean;
  lines?: typeof SETUP_LINES;
}) {
  const outage = unreadable ? { "setup-state": true, devices: true } : {};
  return (
    <StepRail>
      {lines.map((line, index) => (
        <Step
          key={line.id}
          index={String(index + 1).padStart(2, "0")}
          state={stepState(line, outage)}
          title={line.id}
          last={index === lines.length - 1}
        >
          <CopyBlock text={line.command} wrap />
        </Step>
      ))}
    </StepRail>
  );
}

const GATES: {
  title: string;
  caption: string;
  variant: GateVariant;
  phase: GatePhase;
  outcome: GateOutcome | null;
  error: string | null;
  compact: boolean;
}[] = [
  {
    title: "Link · first look",
    caption: "The first launch, before the student has gone anywhere.",
    variant: "link",
    phase: "idle",
    outcome: null,
    error: null,
    compact: false,
  },
  {
    title: "Link · back from the browser",
    caption: "After Discord reports it opened the link. The primary swaps rather than gaining a neighbour.",
    variant: "link",
    phase: "away",
    outcome: null,
    error: null,
    compact: false,
  },
  {
    title: "Link · checked, nothing moved",
    caption: "The one outcome that owes a sentence, because the card is otherwise identical.",
    variant: "link",
    phase: "away",
    outcome: "unchanged",
    error: null,
    compact: false,
  },
  {
    title: "Link · the check itself failed",
    caption: "Same slot, different sentence. It must not read as \u201cnot linked yet\u201d, which the portal did not observe.",
    variant: "link",
    phase: "away",
    outcome: null,
    error: "The live bench could not be reached.",
    compact: false,
  },
  {
    title: "Team · first look",
    caption: "Second step, same mechanism. The destination stays /connect.",
    variant: "team",
    phase: "idle",
    outcome: null,
    error: null,
    compact: false,
  },
  {
    title: "Team · picture-in-picture, waiting",
    caption: "Discord shrinks the Activity to a tile. Kicker and the reopen link go; the sentence and the action stay. The tile size here is a guess, so treat it as a floor rather than a measurement.",
    variant: "team",
    phase: "away",
    outcome: null,
    error: null,
    compact: true,
  },
];

// The first two rungs are the Week 3 reference submission's measured search MRR on
// the test tier (verbatim, keywords); the last two are illustrative.
const LANGUAGE_SWEEP: NonNullable<RunDetailType["sweep"]> = {
  axis: "how far the query is from the caption",
  metric: "search_mrr",
  points: [
    { x: 0, y: 0.6337 },
    { x: 1, y: 0.558 },
    { x: 2, y: 0.49 },
    { x: 3, y: 0.46 },
  ],
};

/* A Language history where one run had no overall. Its producer flags text
 * MRR as primary instead, so the log and the console must name the measure
 * rather than borrow another run's. */
const PARTIAL_MRR: Metric = metric({ key: "text_mrr", label: "Text MRR", value: 0.951, precision: 3, help: null });
const OVERALL: Metric = metric({ key: "overall", label: "Overall", value: 0.443, precision: 3, help: null });
const GALLERY_NOW = 1_790_000_000_000;

const MIXED_HISTORY = [
  { id: "run_00000000a3", mode: "official", attemptNumber: 2, primaryMetric: PARTIAL_MRR, failure: null },
  { id: "run_00000000a2", mode: "official", attemptNumber: 1, primaryMetric: OVERALL, failure: null },
  { id: "run_00000000a1", mode: "practice", attemptNumber: null, primaryMetric: { ...OVERALL, value: 0.391 }, failure: null },
].map((run, index) => RunSummarySchema.parse({
  ...run,
  repo: { owner: "demo", name: "repo", fullName: "demo/repo", url: "https://github.com/demo/repo" },
  status: "succeeded", benchmarkId: "language-search", benchmarkVersion: 1, branch: "main",
  sha: String(index).repeat(40), shortSha: String(index).repeat(7),
  createdAt: GALLERY_NOW - (index + 1) * 3_600_000, finishedAt: GALLERY_NOW - index * 3_600_000,
}));

const UNRANKED_OFFICIAL = RunSurfaceSnapshotSchema.parse({
  id: `surface_${"c".repeat(20)}`,
  team: { id: "team_gallery", name: "Analytical Engines" },
  benchmark: { id: "language-search", version: 1, title: "Semantic Image Search" },
  actor: { login: "ada", name: "Ada" },
  sha: "c".repeat(40), shortSha: "ccccccc", branch: "main",
  source: { owner: "demo", name: "repo", fullName: "demo/repo", url: "https://github.com/demo/repo" },
  sourceRefusal: null, dirty: false, stage: "official", status: "succeeded", phase: "succeeded",
  createdAt: GALLERY_NOW - 600_000, updatedAt: GALLERY_NOW, finishedAt: GALLERY_NOW, silentSince: null,
  elapsedMs: 600_000, progress: null, primaryMetric: PARTIAL_MRR, metrics: [PARTIAL_MRR],
  teamBest: OVERALL, localRunId: null, practiceRunId: "run_00000000b1", officialRunId: "run_00000000b2",
  executionGeneration: 2, executionHistory: [], published: false, nextOfficialAttempt: 3,
  publicationRefusal: 'The leaderboard ranks teams by "overall", and this run didn\'t report it, so it can\'t be published. What it did report stays readable here.',
  events: [], actions: ["open_console", "open_portal"], simulated: true, snapshotRevision: 1,
});

/* The same official result once it reports the ranked measure, so its
 * confirmable actions are drawn. Confirming here sends nothing. */
const PUBLISHABLE_OFFICIAL = RunSurfaceSnapshotSchema.parse({
  ...UNRANKED_OFFICIAL,
  id: `surface_${"d".repeat(20)}`,
  primaryMetric: OVERALL, metrics: [OVERALL], publicationRefusal: null,
  actions: ["open_console", "open_portal", "publish_result", "rerun_hosted"],
});

/* ── Local reports ─────────────────────────────────────────────────────── */

/** Verbatim from the TesterArmy pilot's Week 3 runs (3 October 2026): the
 *  reference submission, and a commit where embed_text averages over the
 *  wrong axis. The benchmark appended the fallback note after the comparison. */
const WEEK3_NOTES = {
  brokenComparison:
    "On the same rewritten queries, your search scored 0.222 and a direct ranking of your embeddings scored 0.006; search runs through your own code and is scored on its first 50 results.",
  brokenFallback:
    "adapter: called embed_text once per item (batch call failed: embed_text returned an array with 1 dimensions; expected a 2-D (rows, D) matrix.)",
  reference:
    "On the same rewritten queries, your search scored 0.222 and a direct ranking of your embeddings scored 0.224; search runs through your own code and is scored on its first 50 results.",
};

function localReport(
  shaPrefix: string,
  over: { value: number; diagnostics: string[]; minutesAgo: number } & Partial<LocalReport>,
): LocalReport {
  const { value, minutesAgo, ...rest } = over;
  // Parsed, so a fixture that breaks the contract (a note over 240
  // characters, a bad sha) fails here instead of showing an impossible row.
  return LocalReportSchema.parse({
    reportId: `local_${shaPrefix}gallery`,
    benchmarkId: "language-search",
    benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v2",
    sdkVersion: "0.2.0",
    pluginVersion: "0.1.0",
    repositoryId: null,
    repositoryFullName: "cogworks-demo/face-finder",
    sha: shaPrefix.padEnd(40, "0"),
    dirty: false,
    startedAt: 1_759_500_000_000,
    finishedAt: 1_759_500_020_000,
    metrics: [metric({ key: "overall", label: "Overall", value, help: null })],
    weightsUsed: [],
    command: "run",
    author: { login: "gallery", name: null },
    syncedAt: Date.now() - minutesAgo * 60_000,
    trust: "local_self_reported",
    ...rest,
  });
}

const LOCAL_REPORTS: LocalReport[] = [
  localReport("d618965", {
    value: 0.1709,
    minutesAgo: 12,
    diagnostics: [WEEK3_NOTES.brokenComparison, WEEK3_NOTES.brokenFallback],
  }),
  localReport("06460ef", { value: 0.4097, minutesAgo: 13, diagnostics: [WEEK3_NOTES.reference] }),
  localReport("3b0c9e2", { value: 0.4097, minutesAgo: 140, diagnostics: [] }),
  localReport("7f41a8d", {
    value: 0.62,
    minutesAgo: 300,
    command: "test",
    dirty: true,
    diagnostics: [WEEK3_NOTES.reference],
  }),
  // Hand-written to reach the states the real runs didn't: five notes, one
  // shaped like HTML (it must show as text), one a long unbroken path.
  localReport("c29e5b1", {
    value: 0.0101,
    minutesAgo: 1_500,
    diagnostics: [
      "retrieval component scored 0: embed_images returned 0 rows for 1000 descriptors; expected one row per descriptor.",
      WEEK3_NOTES.brokenFallback,
      "query rung 'typo': search returned <img src=x onerror=alert(1)> where a list of image ids was expected.",
      "could not load weights from models/" + "encoder_checkpoint_".repeat(8) + "final.npz",
      "search component scored 0: search returned 7 ids for k=50; expected exactly 50.",
    ],
  }),
];

/** Several folded rows, one commit synced twice in the same minute, and a
 *  metric whose label and unit are long unbroken tokens. Each notes control
 *  should read its own report to a screen reader. */
const LOCAL_REPORT_EDGES: LocalReport[] = [
  localReport("4c1f0e2", {
    reportId: "local_4c1f0e2d8a3b4f61c09e7d25a1b3c4e8",
    value: 0.1703,
    minutesAgo: 30,
    metrics: [
      metric({
        key: "overall",
        label: "Mean_reciprocal_rank_over_every_rewritten_query_and_typo_variant",
        unit: "ranks_per_thousand_locally_measured_queries",
        value: 0.1703,
        help: null,
      }),
    ],
    diagnostics: [WEEK3_NOTES.brokenComparison, WEEK3_NOTES.brokenFallback, "third note", "fourth note"],
  }),
  localReport("4c1f0e2", {
    reportId: "local_4c1f0e2f7b16e93d40a2c58b6e9d71f3",
    value: 0.1709,
    minutesAgo: 30,
    diagnostics: [WEEK3_NOTES.brokenComparison, WEEK3_NOTES.brokenFallback, "third note", "fourth note"],
  }),
  localReport("9b3d7e1", {
    value: 0.2214,
    minutesAgo: 90,
    diagnostics: ["first note", "second note", "third note", "fourth note", "fifth note"],
  }),
];

/** A version no track shows, with no catalog to name it, so the id stands in. */
const UNTRACKED_REPORT = localReport("5e1d7a0", {
  value: 0.3311,
  minutesAgo: 4_000,
  benchmarkVersion: 2,
  diagnostics: [WEEK3_NOTES.reference],
});

export function GalleryPage() {
  return (
    <div className="mx-auto w-full max-w-4xl py-10">
      <h1 className="font-serif text-3xl font-semibold text-ink">Component gallery</h1>
      <p className="mt-2 max-w-prose text-[14px] text-ink-secondary">
        States that need a specific run to reach. Development only.
      </p>

      <section className="mt-10 space-y-3">
        <h2 className="font-serif text-xl font-semibold text-ink">Failed execution with recorded findings</h2>
        <p className="text-[13px] text-ink-faint">Saved failure details. Retry needs the run's console to accept one, so none is drawn here.</p>
        <FailureCard
          failure={{ category: "provider", phase: "evaluating", detail: "Runner stopped reporting before completion.", consumedAttempt: false }}
          mode="official"
          benchmarkId="audio-identification"
          module="audio"
        >
          <p className="text-[13px] text-ink-secondary">Saved results</p>
          <Finding sentence="The fingerprints were measured before execution stopped." />
          <SupportingMetrics metrics={[metric()]} rolesRecorded={false} />
        </FailureCard>

        {/* The card above is a provider failure, which has no reproduction
            command, so it never draws that block. This is the shape that
            does: open "Show details" to read the highlighted command. */}
        <h3 className="pt-4 font-serif text-lg font-semibold text-ink">…with a command to reproduce it</h3>
        <FailureCard
          failure={{ category: "output_invalid", phase: "evaluating", detail: 'In result 3, "scores" came back as a dictionary where scoring reads a list. Check what your adapter puts in that field.', consumedAttempt: false }}
          mode="practice"
          benchmarkId="audio-identification"
          module="audio"
        />

        {/* The search stalled on a folder and a slow function, and the
            headline can only name the last hand-off. The notes say why; one
            is open and the rest fold. Text from cogbench's own templates. */}
        <h3 className="pt-4 font-serif text-lg font-semibold text-ink">…a refusal whose search left notes</h3>
        <FailureCard
          failure={{ category: "adapter_missing", phase: "contract_check", detail: "No chain of functions performs clustering.", consumedAttempt: false }}
          mode="practice"
          benchmarkId="vision-clustering"
          module="vision"
          refusal={{
            status: "not_wired",
            headline: "Nothing the search tried took a list of 0 for the labels step, which is what profiles.Profile.match returned.",
            nextStep: "",
            trace: [
              { stage: "descriptors", function: "face_descriptors.describe", returned: "an array of shape (12, 512)" },
              { stage: "graph", function: "profiles.Profile.match", received: "an array of shape (12, 512)", returned: "a list of 0" },
            ],
            notes: [
              "clustering.CoggurtFilter() reads baseImages/ next to its own file; a constructor that takes the folder path as an argument, or reads one relative to the working directory, can be handed them.",
              "whispers.whispers_cluster was still running after 10 seconds, so the check didn't make that same call again. If the benchmark should use it, it has to answer within that time, without loading the full dataset or training first.",
              "graph.build_graph was still running after 10 seconds, so the check didn't make that same call again. If the benchmark should use it, it has to answer within that time, without loading the full dataset or training first.",
            ],
            skipped: [],
            errors: [],
          }}
        />

        {/* B-44's shape: the line that raised was the benchmark's replay, and
            the team's own function is the caller. The runner can't say whose
            fault that is, so the card says where and offers both remedies. */}
        <h3 className="pt-4 font-serif text-lg font-semibold text-ink">…an exception the runner can't attribute</h3>
        <FailureCard
          failure={{
            category: "student_runtime",
            phase: "evaluating",
            detail: "TypeError: 'NoneType' object is not subscriptable\nat cogbench/pipeline.py:834, in replay\ncalled from face_rec/describe.py:41, in describe",
            consumedAttempt: false,
          }}
          mode="practice"
          benchmarkId="vision-recognition"
          module="vision"
        />
      </section>

      <h2 className="mt-10 font-serif text-xl font-semibold text-ink">A result without the ranked measure</h2>
      <p className="mb-4 max-w-prose text-[13px] text-ink-faint">
        The newest attempt reported text MRR and no overall. Each row names its
        measure; the console says why Publish is missing.
      </p>
      <Panel label="RUN LOG">
        <RunList runs={MIXED_HISTORY} connectedFullName="demo/repo" publishedRunId="run_00000000a2" />
      </Panel>
      <div className="mt-4">
        <RunConsole snapshot={UNRANKED_OFFICIAL} streamState="live" onAction={() => undefined} />
      </div>

      <h2 className="mt-10 font-serif text-xl font-semibold text-ink">A result that can be published</h2>
      <p className="mb-4 max-w-prose text-[13px] text-ink-faint">
        Publish and Rerun hosted ask first. Closing the question returns focus to the button that asked it.
      </p>
      <RunConsole snapshot={PUBLISHABLE_OFFICIAL} streamState="live" onAction={() => undefined} />

      <h2 className="mt-10 font-serif text-xl font-semibold text-ink">Activity connect gate</h2>
      <p className="mb-2 max-w-prose text-[13px] text-ink-faint">
        Needs a Discord launch and an unlinked account for real. Buttons are inert.
      </p>
      <div className="grid gap-6 sm:grid-cols-2">
        {GATES.map((example) => (
          <section key={example.title}>
            <div className="u-kicker">{example.title}</div>
            <p className="mb-2 text-[13px] text-ink-faint">{example.caption}</p>
            <div
              className={`grid place-items-center overflow-hidden border border-rule bg-paper p-5 ${
                example.compact ? "h-[220px] w-[300px]" : "h-[460px]"
              }`}
            >
              <ConnectGate
                variant={example.variant}
                phase={example.phase}
                outcome={example.outcome}
                error={example.error}
                compact={example.compact}
                onOpen={() => undefined}
                onCheck={() => undefined}
              />
            </div>
          </section>
        ))}
      </div>

      {/* Reaching it for real takes a teamless account, a printed code that
          hasn't run out, and a join in between. Setup shows it below its
          heading only after the status endpoint says the code is open. */}
      <h2 className="mt-12 font-serif text-xl font-semibold text-ink">A device link held from before the team</h2>
      <p className="mb-4 max-w-prose text-[13px] text-ink-faint">
        Setup&apos;s offer once the student has joined. The link opens the approval page; Dismiss is inert here.
      </p>
      <div className="max-w-[42rem]">
        <HeldDeviceLinkCard
          held={{ path: "/connections?user_code=3F9A-0C7E-B21D&return_to=setup", userCode: "3F9A-0C7E-B21D", login: "gallery" }}
          onDismiss={() => undefined}
        />
      </div>

      <h2 className="mt-12 font-serif text-xl font-semibold text-ink">Finding</h2>
      {CASES.map((example) => (
        <section key={example.title} className="mt-6">
          <div className="u-kicker">{example.title}</div>
          <p className="mb-2 text-[13px] text-ink-faint">{example.note}</p>
          <Panel>
            <Finding sentence={example.sentence} supporting={example.supporting} />
          </Panel>
        </section>
      ))}

      <h2 className="mt-12 font-serif text-xl font-semibold text-ink">Sweep trace</h2>
      {SWEEPS.map((example) => (
        <section key={example.title} className="mt-6">
          <div className="u-kicker">{example.title}</div>
          <p className="mb-2 text-[13px] text-ink-faint">{example.note}</p>
          <Panel>
            <SweepTrace sweep={example.sweep} />
          </Panel>
        </section>
      ))}

      <h2 className="mt-12 font-serif text-xl font-semibold text-ink">
        Supporting metrics, floors
      </h2>
      <p className="mb-2 mt-2 text-[13px] text-ink-faint">
        Left: a floor inside its metric's row. Right: the same floor with its
        parent withheld. Neither draws a direction arrow.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Panel label="FLOOR WITH ITS PARENT">
          <SupportingMetrics metrics={PAIRED_FLOOR} />
        </Panel>
        <Panel label="FLOOR WHOSE PARENT IS WITHHELD">
          <SupportingMetrics metrics={ORPHAN_FLOOR} />
        </Panel>
      </div>

      <h2 className="mt-12 font-serif text-xl font-semibold text-ink">
        Results with no overall score
      </h2>
      <p className="mb-2 mt-2 text-[13px] text-ink-faint">
        Left: a run that withheld its primary. Right: the same metrics with no
        roles recorded (results stored before the portal kept them), so no
        direction claims.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Panel label="NO OVERALL SCORE">
          <p className="max-w-prose text-[14px] leading-[1.6] text-ink">
            This run has no overall score.
          </p>
          <div className="mt-4">
            <SupportingMetrics metrics={WITHHELD} rolesRecorded />
          </div>
        </Panel>
        <Panel label="NO ROLES RECORDED">
          <SupportingMetrics metrics={WITHHELD} rolesRecorded={false} />
        </Panel>
      </div>

      <h2 className="mt-12 font-serif text-xl font-semibold text-ink">
        Setup rail, when the progress read fails
      </h2>
      <p className="mb-2 mt-2 text-[13px] text-ink-faint">
        Identical finished commands. Left: evidence read. Right: the read
        failed, so each step shows a dash and claims nothing.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Panel label="EVIDENCE READ">
          <SetupRailFixture />
        </Panel>
        <Panel label="EVIDENCE UNREADABLE">
          <SetupRailFixture unreadable />
        </Panel>
        <Panel label="CHECKED OFF, NOT OBSERVED">
          <SetupRailFixture lines={SETUP_LINES_SELF_CHECKED} />
        </Panel>
      </div>

      <h2 className="mt-12 font-serif text-xl font-semibold text-ink">Wiring trace</h2>
      <p className="mb-2 mt-2 text-[13px] text-ink-faint">
        The second identifier is 200 characters, the contract's maximum. It
        must wrap, not clip.
      </p>
      <Panel className="mt-4">
        <WiringTrace steps={LONG_WIRING} />
      </Panel>

      <h2 className="mt-12 font-serif text-xl font-semibold text-ink">
        A clean run, whose chart is the whole finding
      </h2>
      <p className="mt-1 max-w-prose text-[13px] text-ink-faint">
        A clean weighted Language run arrives with no diagnostics, so the curve
        is the whole panel and keeps the finding's label.
      </p>
      <Panel className="mt-4">
        <div className="u-kicker mb-2">{FINDING_KICKER}</div>
        <SweepTrace sweep={LANGUAGE_SWEEP} />
      </Panel>

      <h2 className="mt-12 font-serif text-xl font-semibold text-ink">
        Finding above results, as the run page composes them
      </h2>
      <Panel className="mt-4">
        <Finding sentence={CASES[0].sentence} supporting={CASES[0].supporting} />
      </Panel>
      <Panel label="RESULTS" className="mt-4">
        <div className="grid items-start gap-6 sm:grid-cols-2">
          {/* With its floors, which is the shape Week 1 publishes: two of
              them, both of the primary, each carrying its own explanation. */}
          <PrimaryMetric
            metric={metric()}
            floors={[
              metric({
                key: "chance_top1",
                label: "Chance",
                value: 0.0333,
                precision: 3,
                primary: false,
                role: "floor",
                relatesTo: "identification_score",
                help: "1/N for a catalog of N songs: what naming a song at random scores. The floor every other number on this page should be read against.",
              }),
              metric({
                key: "trivial_baseline_top1",
                label: "Trivial baseline",
                value: 0.0812,
                precision: 3,
                primary: false,
                role: "floor",
                relatesTo: "identification_score",
                help: "Whole-clip mean log spectrum, nearest neighbour. No peaks, no fingerprints, none of the capstone.",
              }),
            ]}
          />
          <SupportingMetrics metrics={SUPPORTING} />
        </div>
        <p className="mt-4 border-t border-rule-soft pt-3 font-mono text-[11px] text-ink-faint">
          Public practice split.
        </p>
      </Panel>
      <h2 className="mt-12 font-serif text-xl font-semibold text-ink">
        Local reports, as a teammate reads them
      </h2>
      <p className="mt-2 max-w-prose text-[13px] text-ink-faint">
        At the Runs page&apos;s width. The first two rows are the pilot&apos;s real Week 3 reports with their
        notes verbatim; the rest are hand-written to reach no notes, a dirty smoke test, and five notes with an
        HTML-shaped one and a long unbroken one.
      </p>
      <div className="mt-6 max-w-[42rem]">
        <LocalReportsTable reports={LOCAL_REPORTS} caption="Gallery: self-reported local CogBench results" />
      </div>
      <h3 className="mt-8 font-serif text-lg font-semibold text-ink">
        …several folded rows, a repeated commit, and a long metric name
      </h3>
      <div className="mt-3 max-w-[42rem]">
        <LocalReportsTable reports={LOCAL_REPORT_EDGES} caption="Gallery: folded rows and a long metric name" />
      </div>
      <div className="mt-8 max-w-[42rem]">
        <LocalReportsTable
          reports={[UNTRACKED_REPORT]}
          catalog={[]}
          caption="Gallery: a self-reported result for a benchmark version without a track"
        />
      </div>

      <h2 className="mt-12 font-serif text-xl font-semibold text-ink">Published results, as a visitor reads them</h2>
      <p className="mt-2 max-w-prose text-[13px] text-ink-faint">
        At the leaderboard&apos;s width. Sent in score order; the board shows them newest first. Open each
        Details: every role, a run with no recorded roles, an archive row, a team with no line, a curve
        missing a point, and a run with no curve among runs that have one.
      </p>
      <div className="mt-6 max-w-[42rem]">
        <BoardContext
          lead="Caption-to-image retrieval with your trained encoder in the caption-embedding space."
          scope={benchmarkScopeLine({ id: "language-search", version: 1, scorerVersion: "retrieval-v4" })}
        />
        <PublishedGallery entries={BOARD_ENTRIES} />
      </div>
    </div>
  );
}
