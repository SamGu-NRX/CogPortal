/**
 * Cog*Portal shared contract (handoff-plan §6).
 *
 * Single source of truth for every payload that crosses the browser ⇄ Worker
 * boundary. The Worker validates requests with these schemas and shapes its
 * responses to satisfy them; the browser trusts the inferred types.
 *
 * Rule from the plan: metrics are data-driven, the portal never assumes
 * "higher is better", and benchmark/contract versions ride on every run.
 */
import { z } from "zod";

/* ── Enumerations ─────────────────────────────────────────────────────── */

export const RUN_MODES = ["practice", "official"] as const;
export const RunModeSchema = z.enum(RUN_MODES);
export type RunMode = z.infer<typeof RunModeSchema>;

/** Ordered pipeline phases, exactly as shown on the phase rail (§8). */
export const RUN_PHASES = [
  "queued",
  "preparing",
  "installing",
  "contract_check",
  "evaluating",
  "scoring",
] as const;
export const RunPhaseSchema = z.enum(RUN_PHASES);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

export const RUN_STATUSES = [
  ...RUN_PHASES,
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled"] as const;
export function isTerminal(status: RunStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export const FAILURE_CATEGORIES = [
  "repository_fetch",
  "dependency_install",
  "data_download",
  "model_cache",
  "adapter_missing",
  "contract_invalid",
  "student_runtime",
  "timeout",
  "memory_limit",
  "output_invalid",
  "scorer",
  "provider",
] as const;
export const FailureCategorySchema = z.enum(FAILURE_CATEGORIES);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

export const ModuleSchema = z.enum(["vision", "audio", "language"]);
export type Module = z.infer<typeof ModuleSchema>;

/* ── Metrics (data-driven, §6) ────────────────────────────────────────── */

export const MetricSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  unit: z.string().nullable(),
  higherIsBetter: z.boolean(),
  primary: z.boolean(),
  /** display precision, number of decimal places */
  precision: z.number().int().min(0).max(6),
  /**
   * One or two sentences on what this measures, in the course's vocabulary,
   * and which part of the capstone it corresponds to. Optional: benchmarks
   * that predate it send nothing, and the UI shows no help affordance then.
   */
  help: z.string().nullish(),
});
export type Metric = z.infer<typeof MetricSchema>;

/* ── Runs ─────────────────────────────────────────────────────────────── */

export const PhaseTimingSchema = z.object({
  phase: RunPhaseSchema,
  startedAt: z.number().nullable(), // epoch ms
  endedAt: z.number().nullable(),
});
export type PhaseTiming = z.infer<typeof PhaseTimingSchema>;

export const RunFailureSchema = z.object({
  category: FailureCategorySchema,
  phase: RunPhaseSchema,
  /** Safe, run-specific one-liner (e.g. the missing entry-point name). */
  detail: z.string().nullable(),
  /** Authoritative: whether this failure consumed an official attempt. */
  consumedAttempt: z.boolean(),
});
export type RunFailure = z.infer<typeof RunFailureSchema>;

export const RepoRefSchema = z.object({
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  url: z.string(),
  defaultBranch: z.string(),
});
export type RepoRef = z.infer<typeof RepoRefSchema>;

export const RunSummarySchema = z.object({
  id: z.string(),
  mode: RunModeSchema,
  status: RunStatusSchema,
  benchmarkId: z.string(),
  benchmarkVersion: z.number().int(),
  branch: z.string(),
  sha: z.string().length(40),
  shortSha: z.string(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
  /** 1..3 for official runs, null for practice. */
  attemptNumber: z.number().int().nullable(),
  primaryMetric: MetricSchema.nullable(),
  failure: RunFailureSchema.nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunDetailSchema = RunSummarySchema.extend({
  contractVersion: z.string(),
  parentRunId: z.string().nullable(),
  repo: RepoRefSchema,
  phases: z.array(PhaseTimingSchema),
  metrics: z.array(MetricSchema),
  /** The scorer's own notes on this run: which component scored zero and why.
   *  Safe for official runs; they describe the submission, never the data. */
  diagnostics: z.array(z.string().max(240)).max(32),
  /**
   * How the score moved as the benchmark's difficulty knob turned. Null when
   * the benchmark has no such knob, or when the run predates the sweep.
   *
   * Shape mirrors the runner protocol's `SweepSchema` rather than importing
   * it, because this file describes what the browser receives and that one
   * describes what the sandbox sends; they are allowed to drift.
   */
  sweep: z
    .object({
      axis: z.string().max(60),
      metric: z.string().max(60),
      points: z
        .array(
          z.object({
            x: z.number(),
            y: z.number(),
            label: z.string().max(40).optional(),
          }),
        )
        .max(24),
    })
    .nullable()
    .default(null),
  /**
   * Which of the team's own functions ran, in the order they ran. Empty when
   * the repository declared its own submission, because then nothing was
   * inferred and there is no inference to show.
   *
   * Safe for official runs on the same grounds as diagnostics: it names their
   * code and the shapes it passed, never the hidden data.
   */
  wiring: z
    .array(
      z.object({
        stage: z.string().max(60),
        function: z.string().max(200),
        received: z.string().max(200).optional(),
        returned: z.string().max(200).optional(),
      }),
    )
    .max(16)
    .default([]),
  /**
   * Why the platform could not find code to score, when that is what failed.
   * Null for every other failure and for every run that succeeded.
   *
   * Separate from `failure.detail`, which is one capped line meant for a log.
   * This is the part a student acts on: the step that stalled, what their
   * last function returned, and the one next thing to do.
   */
  refusal: z
    .object({
      status: z.string().max(40),
      headline: z.string().max(600),
      nextStep: z.string().max(600).default(""),
      trace: z
        .array(
          z.object({
            stage: z.string().max(60),
            function: z.string().max(200),
            received: z.string().max(200).optional(),
            returned: z.string().max(200).optional(),
          }),
        )
        .max(16)
        .default([]),
    })
    .nullable()
    .default(null),
  /** Capped install/eval log. Practice runs only; null for official (§5). */
  log: z.string().nullable(),
  /** Official runs: currently published on the leaderboard. */
  selected: z.boolean(),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

/* ── Benchmarks ───────────────────────────────────────────────────────── */

export const BenchmarkSchema = z.object({
  id: z.string(), // e.g. "vision-recognition"
  version: z.number().int(),
  contractVersion: z.string(), // e.g. "cogworks.submissions.v1"
  entryPointName: z.string(), // e.g. "vision-recognition"
  title: z.string(),
  module: ModuleSchema,
  summary: z.string(),
  active: z.boolean(),
  pluginVersion: z.string(),
  datasetVersion: z.string(),
  scorerVersion: z.string(),
  runtimeVersion: z.string(),
});
export type Benchmark = z.infer<typeof BenchmarkSchema>;

export const BenchmarkFamilyComponentSchema = z.object({
  key: z.string(),
  label: z.string(),
  benchmarkId: z.string(),
  benchmarkVersion: z.number().int(),
  metricKey: z.string(),
  weight: z.number().positive(),
});

export const BenchmarkFamilySchema = z.object({
  id: z.string(),
  version: z.number().int(),
  title: z.string(),
  module: ModuleSchema,
  active: z.boolean(),
  components: z.array(BenchmarkFamilyComponentSchema).min(1),
});
export type BenchmarkFamily = z.infer<typeof BenchmarkFamilySchema>;

/* ── Team / session / quota ───────────────────────────────────────────── */

export const QuotaSchema = z.object({
  practiceUsed: z.number().int(),
  practiceLimit: z.number().int(), // 10 (plan §11)
  officialUsed: z.number().int(),
  officialLimit: z.number().int(), // 3 (plan §11)
});
export type Quota = z.infer<typeof QuotaSchema>;

export const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  repo: RepoRefSchema.nullable(),
});
export type Team = z.infer<typeof TeamSchema>;

/** System-level role: staff (TA/instructor) vs student. Derived from the
 *  PLATFORM_STAFF_LOGINS env allowlist at request time — never stored. */
export const PlatformRoleSchema = z.enum(["student", "staff"]);
export type PlatformRole = z.infer<typeof PlatformRoleSchema>;

/** What identity paths this deployment offers (drives the sign-in screen). */
export const AuthConfigSchema = z.object({
  /** GitHub App OAuth is configured — "Continue with GitHub" is real. */
  githubConfigured: z.boolean(),
  /** Local sign-in is available (never in production). */
  devAuthEnabled: z.boolean(),
  /** Owner-only setup replay/reset controls are enabled for this deployment. */
  onboardingDevToolsEnabled: z.boolean(),
  /** GitHub App slug, for the …/installations/new install link. */
  appSlug: z.string().nullable(),
  /** Course template repository (owner/name); submissions must fork it. */
  templateRepo: z.string().nullable(),
  /** Active execution provider — "fixture" runs are simulated (pre-M0). */
  executionProvider: z.enum(["fixture", "modal"]),
});
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export const SessionSchema = z.object({
  user: z
    .object({
      login: z.string(),
      name: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      platformRole: PlatformRoleSchema,
      /** Product ownership is distinct from staff authorization; multiple
       *  owners may be configured for a deployment. */
      isOwner: z.boolean(),
      /** True when this user is assigned to at least one project team as TA. */
      isTa: z.boolean(),
    })
    .nullable(),
  cohort: z.object({ slug: z.string(), name: z.string() }).nullable(),
  team: TeamSchema.nullable(),
  auth: AuthConfigSchema,
});
export type Session = z.infer<typeof SessionSchema>;

/* ── Account connections and local reports ───────────────────────────── */

export const ConnectionSummarySchema = z.object({
  // Null when the account has no GitHub identity. GitHub sign-in always
  // creates one; dev-auth users don't, and a required `login` here made the
  // whole connections endpoint 500 for them.
  github: z
    .object({
      id: z.number().int().nullable(),
      login: z.string(),
      avatarUrl: z.string().nullable(),
    })
    .nullable(),
  discord: z
    .object({
      userId: z.string(),
      username: z.string(),
      linkedAt: z.number().int(),
    })
    .nullable(),
  cliDevices: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      createdAt: z.number().int(),
      lastUsedAt: z.number().int().nullable(),
    }),
  ),
});
export type ConnectionSummary = z.infer<typeof ConnectionSummarySchema>;

export const ConfirmDiscordLinkRequestSchema = z.object({
  token: z.string().min(32).max(256),
});

export const DiscordLinkPreviewSchema = z.object({
  username: z.string(),
  expiresAt: z.number().int(),
});

export const DeviceAuthorizationStartResponseSchema = z.object({
  deviceCode: z.string().min(32),
  // Three groups since the 48-bit entropy hardening (6 bytes → 12 hex chars);
  // the old two-group pattern rejected every code the worker now issues.
  userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  verificationUri: z.string().url(),
  expiresAt: z.number().int(),
  pollIntervalSeconds: z.number().int().min(2).max(30),
});
export type DeviceAuthorizationStartResponse = z.infer<
  typeof DeviceAuthorizationStartResponseSchema
>;

export const ApproveDeviceRequestSchema = z.object({
  userCode: z.string().trim().toUpperCase(),
  deviceName: z.string().trim().min(1).max(80),
});

export const RevokeDeviceRequestSchema = z.object({
  deviceId: z.string().min(1).max(128),
});

export const DeviceTokenRequestSchema = z.object({
  deviceCode: z.string().min(32).max(256),
});

export const DeviceTokenResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), retryAfterSeconds: z.number().int() }),
  z.object({
    status: z.literal("authorized"),
    token: z.string().min(32),
    expiresAt: z.number().int(),
  }),
]);
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;

export const LocalReportInputSchema = z.object({
  reportId: z.string().min(8).max(128),
  benchmarkId: z.string().min(1).max(120),
  benchmarkVersion: z.number().int().positive(),
  contractVersion: z.string().min(1).max(120),
  sdkVersion: z.string().min(1).max(80),
  pluginVersion: z.string().min(1).max(80),
  repositoryId: z.number().int().positive().nullable(),
  repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/).nullable(),
  sha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  dirty: z.boolean(),
  startedAt: z.number().int(),
  finishedAt: z.number().int(),
  metrics: z.array(MetricSchema).max(32),
  diagnostics: z.array(z.string().max(240)).max(32),
});
export type LocalReportInput = z.infer<typeof LocalReportInputSchema>;

export const LocalReportSchema = LocalReportInputSchema.extend({
  author: z.object({
    login: z.string(),
    name: z.string().nullable(),
  }),
  syncedAt: z.number().int(),
  trust: z.literal("local_self_reported"),
});
export type LocalReport = z.infer<typeof LocalReportSchema>;

export const LocalReportListSchema = z.array(LocalReportSchema);

/** Public-to-the-team lifecycle for an explicitly shared local CogBench run.
 *  These phases describe the student process; they are intentionally smaller
 *  than the hosted runner pipeline. */
export const LOCAL_RUN_PHASES = [
  "preparing",
  "contract_check",
  "evaluating",
  "scoring",
] as const;
export const LocalRunPhaseSchema = z.enum(LOCAL_RUN_PHASES);
export type LocalRunPhase = z.infer<typeof LocalRunPhaseSchema>;

export const RUN_LIFECYCLE_STAGES = [
  "local",
  "hosted",
  "official",
  "published",
] as const;
export const RunLifecycleStageSchema = z.enum(RUN_LIFECYCLE_STAGES);
export type RunLifecycleStage = z.infer<typeof RunLifecycleStageSchema>;

export const RUN_STREAM_EVENT_CODES = [
  "repository.ready",
  "repository.fetching",
  "dependencies.installing",
  "contract.checking",
  "contract.passed",
  "evaluation.started",
  "evaluation.progress",
  "scoring.started",
  "run.completed",
  "run.failed.repository",
  "run.failed.dependencies",
  "run.failed.contract",
  "run.failed.runtime",
  "run.failed.timeout",
  "run.failed.memory",
  "run.failed.output",
  "run.failed.scorer",
  "run.failed.provider",
] as const;
export const RunStreamEventCodeSchema = z.enum(RUN_STREAM_EVENT_CODES);
export type RunStreamEventCode = z.infer<typeof RunStreamEventCodeSchema>;

export const RunProgressSchema = z.object({
  current: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  unit: z.enum(["cases", "items"]),
}).refine((value) => value.current <= value.total, {
  message: "Progress cannot exceed its total.",
});
export type RunProgress = z.infer<typeof RunProgressSchema>;

export const RunStreamEventSchema = z.object({
  eventId: z.string().min(8).max(128),
  source: z.enum(["local", "practice", "official", "system"]),
  sourceRunId: z.string().min(1).max(128),
  sourceSequence: z.number().int().nonnegative(),
  phase: z.string().min(1).max(40),
  code: RunStreamEventCodeSchema,
  occurredAt: z.number().int().positive(),
  elapsedMs: z.number().int().nonnegative().nullable(),
  progress: RunProgressSchema.nullable(),
});
export type RunStreamEvent = z.infer<typeof RunStreamEventSchema>;

/** Keeps only the newest heartbeat in a visually identical run of events.
 * Durable history remains lossless; compact realtime projections use this. */
export function collapseRepeatedRunEvents(events: readonly RunStreamEvent[]): RunStreamEvent[] {
  const collapsed: RunStreamEvent[] = [];
  for (const event of events) {
    const previous = collapsed.at(-1);
    const sameProgress = previous?.progress?.current === event.progress?.current
      && previous?.progress?.total === event.progress?.total
      && previous?.progress?.unit === event.progress?.unit;
    if (
      previous
      && previous.sourceRunId === event.sourceRunId
      && previous.phase === event.phase
      && previous.code === event.code
      && sameProgress
    ) {
      collapsed[collapsed.length - 1] = event;
    } else {
      collapsed.push(event);
    }
  }
  return collapsed;
}

export const RunSurfaceActionSchema = z.enum([
  "open_console",
  "open_portal",
  "verify_hosted",
  "run_again",
  "promote_official",
  "rerun_hosted",
  "publish_result",
]);
export type RunSurfaceAction = z.infer<typeof RunSurfaceActionSchema>;

export const RunSurfaceSnapshotSchema = z.object({
  id: z.string().regex(/^surface_[a-f0-9]{20}$/),
  team: z.object({ id: z.string(), name: z.string() }),
  benchmark: z.object({
    id: z.string(),
    version: z.number().int().positive(),
    title: z.string(),
  }),
  actor: z.object({ login: z.string(), name: z.string().nullable() }),
  sha: z.string().length(40),
  shortSha: z.string(),
  branch: z.string().nullable(),
  dirty: z.boolean(),
  stage: RunLifecycleStageSchema,
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  phase: z.string().min(1).max(40),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  elapsedMs: z.number().int().nonnegative(),
  progress: RunProgressSchema.nullable(),
  primaryMetric: MetricSchema.nullable(),
  /** Every metric of the current run, primary first; empty until scored. */
  metrics: z.array(MetricSchema).default([]),
  /** Best observed (hosted/official) primary metric on this benchmark from the team's other surfaces. */
  teamBest: MetricSchema.nullable().default(null),
  localRunId: z.string().nullable(),
  practiceRunId: z.string().nullable(),
  officialRunId: z.string().nullable(),
  published: z.boolean(),
  nextOfficialAttempt: z.number().int().positive().nullable(),
  /**
   * One sentence saying why nothing could be scored, when that is what
   * failed. Null otherwise.
   *
   * Discord shows "Contract check stopped", which is true and says nothing a
   * team can act on. The reason is already written; carrying it here is what
   * makes the message worth reading.
   */
  refusalHeadline: z.string().max(600).nullable().default(null),
  events: z.array(RunStreamEventSchema).max(250),
  actions: z.array(RunSurfaceActionSchema),
  simulated: z.boolean(),
});
export type RunSurfaceSnapshot = z.infer<typeof RunSurfaceSnapshotSchema>;

export function runSurfaceCurrentRunId(snapshot: RunSurfaceSnapshot): string | null {
  if (snapshot.stage === "local") return snapshot.localRunId;
  if (snapshot.stage === "hosted") return snapshot.practiceRunId;
  return snapshot.officialRunId;
}

/** Projects the history for the lifecycle stage currently on screen.
 * Durable history still retains every stage, but a live view must not describe
 * a completed local run while hosted or official work is active. */
export function runSurfaceCurrentEvents(snapshot: RunSurfaceSnapshot): RunStreamEvent[] {
  const runId = runSurfaceCurrentRunId(snapshot);
  return runId ? snapshot.events.filter((event) => event.sourceRunId === runId) : [];
}

export const StartLocalRunRequestSchema = z.object({
  clientRunId: z.string().regex(/^localrun_[a-f0-9]{32}$/),
  benchmarkId: z.string().min(1).max(120),
  benchmarkVersion: z.number().int().positive(),
  repositoryId: z.number().int().positive().nullable(),
  repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  branch: z.string().trim().min(1).max(255).nullable().optional(),
  dirty: z.boolean(),
});
export type StartLocalRunRequest = z.infer<typeof StartLocalRunRequestSchema>;

export const StartLocalRunResponseSchema = z.object({
  sessionId: z.string().min(1).max(128),
  surfaceId: z.string().regex(/^surface_[a-f0-9]{20}$/),
  discord: z.enum(["published", "channel_unbound", "unavailable"]),
});
export type StartLocalRunResponse = z.infer<typeof StartLocalRunResponseSchema>;

const LocalRunEventBaseSchema = z.object({
  eventId: z.string().min(8).max(128),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.number().int().positive(),
  elapsedMs: z.number().int().nonnegative().optional(),
});

export const LocalRunEventSchema = z.discriminatedUnion("type", [
  LocalRunEventBaseSchema.extend({
    type: z.literal("progress"),
    phase: LocalRunPhaseSchema,
    code: RunStreamEventCodeSchema.optional(),
    progress: RunProgressSchema.optional(),
  }),
  LocalRunEventBaseSchema.extend({
    type: z.literal("completed"),
    report: LocalReportInputSchema,
  }),
  LocalRunEventBaseSchema.extend({
    type: z.literal("failed"),
    phase: LocalRunPhaseSchema,
    code: RunStreamEventCodeSchema.optional(),
    /** Accepted for older CLIs, but never copied into a shared run surface. */
    detail: z.string().trim().min(1).max(240).optional(),
  }),
]);
export type LocalRunEvent = z.infer<typeof LocalRunEventSchema>;

export const LocalRunEventBatchSchema = z.object({
  events: z.array(LocalRunEventSchema).min(1).max(32),
}).superRefine((value, context) => {
  for (let index = 1; index < value.events.length; index += 1) {
    if (value.events[index]!.sequence <= value.events[index - 1]!.sequence) {
      context.addIssue({
        code: "custom",
        path: ["events", index, "sequence"],
        message: "Batched local run events must be strictly ordered.",
      });
    }
  }
  for (let index = 0; index < value.events.length - 1; index += 1) {
    if (value.events[index]!.type !== "progress") {
      context.addIssue({
        code: "custom",
        path: ["events", index, "type"],
        message: "A terminal local run event must be the final event in its batch.",
      });
    }
  }
});
export type LocalRunEventBatch = z.infer<typeof LocalRunEventBatchSchema>;

export const LocalRunEventResponseSchema = z.object({
  ok: z.literal(true),
  duplicate: z.boolean(),
  discord: z.enum(["updated", "not_published", "unavailable"]),
});
export type LocalRunEventResponse = z.infer<typeof LocalRunEventResponseSchema>;

export const LocalRunEventBatchResponseSchema = z.object({
  ok: z.literal(true),
  accepted: z.number().int().nonnegative(),
  duplicate: z.boolean(),
  discord: z.enum(["updated", "not_published", "unavailable"]),
});
export type LocalRunEventBatchResponse = z.infer<typeof LocalRunEventBatchResponseSchema>;

export const DeviceStatusSchema = z.object({
  githubLogin: z.string(),
  teamName: z.string(),
  repositoryFullName: z.string(),
  discordChannelId: z.string().nullable(),
  deviceName: z.string(),
  deviceExpiresAt: z.number().int(),
});
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

/* ── Composite payloads ───────────────────────────────────────────────── */

export const SelectionSchema = z.object({
  runId: z.string(),
  selectedAt: z.number(),
  primaryMetric: MetricSchema,
  shortSha: z.string(),
  attemptNumber: z.number().int().nullable(),
});
export type Selection = z.infer<typeof SelectionSchema>;

/** GET /api/dashboard?benchmark=… — one request answers §8's questions. */
export const DashboardSchema = z.object({
  benchmark: BenchmarkSchema,
  team: TeamSchema,
  quota: QuotaSchema,
  lastResolvedSha: z.string().nullable(),
  activeRun: RunSummarySchema.nullable(),
  /** Most recent succeeded practice run (the promotable candidate). */
  latestCandidate: RunSummarySchema.nullable(),
  selection: SelectionSchema.nullable(),
  runs: z.array(RunSummarySchema),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

export const LeaderboardEntrySchema = z.object({
  rank: z.number().int(),
  teamName: z.string(),
  teamDescription: z.string().nullable(),
  repoUrl: z.string().nullable(),
  sha: z.string(),
  shortSha: z.string(),
  primaryMetric: MetricSchema,
  supportingMetrics: z.array(MetricSchema),
  completedAt: z.number(),
  isYou: z.boolean(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const LeaderboardSchema = z.object({
  benchmark: BenchmarkSchema,
  entries: z.array(LeaderboardEntrySchema),
});
export type Leaderboard = z.infer<typeof LeaderboardSchema>;

export const FamilyLeaderboardSchema = z.object({
  family: BenchmarkFamilySchema,
  entries: z.array(LeaderboardEntrySchema),
});
export type FamilyLeaderboard = z.infer<typeof FamilyLeaderboardSchema>;

/** GET /api/github/repositories */
export const GithubRepoSchema = RepoRefSchema.extend({
  repositoryId: z.number().int().positive().nullable(),
  branches: z.array(z.string()),
  /** Name of the team already bound to this repo in the caller's cohort. */
  claimedByTeam: z.string().nullable(),
  /** GitHub repo description (not cogportal.toml). */
  description: z.string().nullable(),
  /** GitHub `fork` flag; the template check itself stays server-side. */
  isFork: z.boolean(),
  /** Last push, epoch ms; null when GitHub omits it. */
  pushedAt: z.number().nullable(),
});
export type GithubRepo = z.infer<typeof GithubRepoSchema>;

/** GET /api/github/installations */
export const GithubInstallationSchema = z.object({
  id: z.number(),
  account: z.string(),
  accountType: z.string(),
  avatarUrl: z.string().nullable(),
});
export type GithubInstallation = z.infer<typeof GithubInstallationSchema>;

/* ── Team management ──────────────────────────────────────────────────── */

export const TeamMemberSchema = z.object({
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: z.enum(["admin", "maintain", "write"]),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

/** GET /api/team */
export const TeamDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  repo: RepoRefSchema,
  members: z.array(TeamMemberSchema),
  tas: z.array(
    z.object({
      login: z.string(),
      name: z.string().nullable(),
      avatarUrl: z.string().nullable(),
    }),
  ),
  /** Caller created the team (first to connect the repo) → may rename. */
  isAdmin: z.boolean(),
});
export type TeamDetail = z.infer<typeof TeamDetailSchema>;

/** PATCH /api/team — team admin only; at least one field. */
export const UpdateTeamRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    /** "" and null both clear the description; cap matches cogportal.toml. */
    description: z
      .string()
      .trim()
      .max(280)
      .nullable()
      .optional()
      .transform((value) => (value === undefined ? undefined : value || null)),
  })
  .refine((body) => body.name !== undefined || body.description !== undefined, {
    message: "Provide a name or description to update.",
  });

/** POST /api/team/repository — team admin only. */
export const ChangeTeamRepoRequestSchema = z.object({
  fullName: z.string().trim().regex(/^[^/\s]+\/[^/\s]+$/, "owner/name"),
});

/* ── Process signals ───────────────────────────────────────────────────
 * See docs/design/the-instrument-not-the-judge.md, "The process layer."
 * Four signals derived from a team's GitHub history and runs. Two rules
 * hold on every shape below, checked by a test that walks the JSON
 * recursively: no per-person totals in any form, and a signal this cannot
 * compute reports why rather than guessing (see HistoryQualitySchema and
 * the `available`/`unavailableReason` pair on StageActivitySchema). */

/** How trustworthy a team's commit history is for the three commit-derived
 *  signals below. `bulk_upload` and `empty` are real, observed states (a
 *  team pushed one commit, or has none yet); `fetch_failed` means the
 *  Worker could not read GitHub just now, kept distinct from `empty` so
 *  "no history" and "could not check" are never conflated. */
export const HISTORY_QUALITIES = ["usable", "bulk_upload", "empty", "fetch_failed"] as const;
export const HistoryQualitySchema = z.enum(HISTORY_QUALITIES);
export type HistoryQuality = z.infer<typeof HistoryQualitySchema>;

/** What was observed for one capstone stage. `commitCount` and
 *  `distinctAuthorCount` are null, not 0, when `available` is false. */
export const StageActivitySchema = z.object({
  commitCount: z.number().int().nullable(),
  distinctAuthorCount: z.number().int().nullable(),
  firstTouchAt: z.number().nullable(),
  lastTouchAt: z.number().nullable(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
});
export type StageActivity = z.infer<typeof StageActivitySchema>;

/** The integration instrument: the first run that scored end to end, and
 *  the count since. Built from runs, the portal's own observation, so this
 *  never depends on history quality. */
export const FirstLightSchema = z.object({
  firstScoredAt: z.number().nullable(),
  scoredRunCount: z.number().int(),
});
export type FirstLight = z.infer<typeof FirstLightSchema>;

/** A commit that touched a contract file (`submission.py`,
 *  `benchmark_adapter.py`) after the team's first scored run. */
export const ChurnEventSchema = z.object({
  sha: z.string(),
  authorLogin: z.string(),
  authoredAt: z.number(),
  files: z.array(z.string()),
});
export type ChurnEvent = z.infer<typeof ChurnEventSchema>;

/** GET /api/v1/team/process — team members only. Cached; recomputed when
 *  older than 30 minutes (see worker/routes/team.ts). `weekLabel` is null
 *  for a team with no runs yet, which is also when `stageFootprint` and
 *  `ownershipBreadth` are empty objects: no run means no way to know which
 *  capstone stage map applies, so there is no stage list to report against. */
export const TeamProcessSignalsSchema = z.object({
  historyQuality: HistoryQualitySchema,
  weekLabel: z.enum(["week1", "week2", "week3"]).nullable(),
  stageFootprint: z.record(z.string(), StageActivitySchema),
  firstLight: FirstLightSchema,
  boundaryChurn: z.array(ChurnEventSchema),
  ownershipBreadth: z.record(z.string(), z.array(z.string())),
  findingSentences: z.array(z.string()),
  computedAt: z.number(),
});
export type TeamProcessSignals = z.infer<typeof TeamProcessSignalsSchema>;

/* ── Joining an existing team ─────────────────────────────────────────── */

/** One team in the caller's cohort, as shown on the join-a-team browser.
 *  Cohorts are classroom-sized, so the full member list ships inline. */
export const CohortTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  repo: z.object({
    fullName: z.string(),
    url: z.string(),
  }),
  members: z.array(
    z.object({
      login: z.string(),
      name: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      role: z.enum(["admin", "maintain", "write"]),
    }),
  ),
  /** GitHub login of the team creator — who to ask for access. */
  adminLogin: z.string().nullable(),
});
export type CohortTeam = z.infer<typeof CohortTeamSchema>;

/** GET /api/cohorts/teams — every team in the caller's cohort. */
export const CohortTeamListSchema = z.array(CohortTeamSchema);

/** POST /api/team/join — join by team id. The server verifies the caller
 *  has write access to the team's repository (the repository is the team);
 *  a 403 `repo_access_required` names the creator to ask. Responds with
 *  the joined TeamDetail. */
export const JoinTeamRequestSchema = z.object({
  teamId: z.string().min(1),
});

/* ── Setup guide verification (terminal callback) ─────────────────────── */

/** Machine-local steps a student can explicitly report after a real CLI
 *  command checks them. Test/run are later learning milestones and do not
 *  gate day-zero setup. */
export const SETUP_STEPS = [
  "clone",
  "environment",
  "project",
  "wiring",
  "test",
  "run",
] as const;
export const SetupStepSchema = z.enum(SETUP_STEPS);
export type SetupStep = z.infer<typeof SetupStepSchema>;

/** POST /api/v1/cli/setup/checks. A linked CLI sends only coarse pass
 *  evidence: no paths, source, logs, predictions, metrics, or reports. */
export const SetupEvidenceRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    checks: z.array(SetupStepSchema).min(1).max(SETUP_STEPS.length),
    cliVersion: z.string().min(1).max(40),
    pythonVersion: z.string().min(1).max(40),
    benchmarkIds: z.array(z.string().min(1).max(100)).max(12),
    submissionIds: z.array(z.string().min(1).max(100)).max(12),
  })
  .strict();
export type SetupEvidenceRequest = z.infer<typeof SetupEvidenceRequestSchema>;

export const SetupEvidenceResponseSchema = z
  .object({
    accepted: z.array(SetupStepSchema),
  })
  .strict();
export type SetupEvidenceResponse = z.infer<typeof SetupEvidenceResponseSchema>;

/** GET /api/v1/setup/state — CLI-checked state for the signed-in student's
 *  current team. */
export const SetupStateSchema = z
  .object({
    verified: z.array(SetupStepSchema),
  })
  .strict();
export type SetupState = z.infer<typeof SetupStateSchema>;

/* ── Team member management (team admin only) ─────────────────────────── */

/** A cohort student who could be added to the caller's team. */
export const InvitableUserSchema = z.object({
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type InvitableUser = z.infer<typeof InvitableUserSchema>;

/** GET /api/team/invitable — cohort members with no team yet. */
export const InvitableUserListSchema = z.array(InvitableUserSchema);

/** POST /api/team/members — add a cohort member to the team (role `write`).
 *  Portal membership only; pushing still needs GitHub collaborator access.
 *  Responds with the updated TeamDetail. */
export const AddTeamMemberRequestSchema = z.object({
  login: z
    .string()
    .trim()
    .min(1)
    .max(39)
    .regex(/^[a-zA-Z0-9-]+$/),
});

/** DELETE /api/team/members/:login — remove a member (never the creator).
 *  Responds with the updated TeamDetail. */

/* ── Requests ─────────────────────────────────────────────────────────── */

export const StartPracticeRequestSchema = z.object({
  benchmarkId: z.string(),
  branch: z.string().optional(),
});
export const JoinCohortRequestSchema = z.object({
  code: z.string().min(4).max(32),
});
export const ConnectRepoRequestSchema = z.object({
  fullName: z.string(),
  /** Required when the repository has no team yet — the caller creates it. */
  teamName: z.string().trim().min(1).max(60).optional(),
});
export const SelectResultRequestSchema = z.object({
  runId: z.string(),
});
export const DevLoginRequestSchema = z.object({
  login: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[a-zA-Z0-9-]+$/),
  /** Dev only: provision user → cohort → fixture team in one step. */
  demo: z.boolean().optional(),
});

export const StartRunResponseSchema = z.object({ runId: z.string() });

/* ── Admin console (staff only, deliberately small) ───────────────────── */

export const AdminTeamSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  repoFullName: z.string(),
  members: z.array(
    z.object({
      login: z.string(),
      name: z.string().nullable(),
      role: z.enum(["admin", "maintain", "write"]),
    }),
  ),
  tas: z.array(
    z.object({
      login: z.string(),
      name: z.string().nullable(),
      avatarUrl: z.string().nullable(),
    }),
  ),
  practiceUsed: z.number().int(),
  officialUsed: z.number().int(),
  /** Currently published primary metric value, when a selection exists. */
  publishedScore: z.number().nullable(),
});
export type AdminTeamSummary = z.infer<typeof AdminTeamSummarySchema>;

/** GET /api/admin/overview */
export const AdminOverviewSchema = z.object({
  scope: z.enum(["owner", "ta"]),
  cohort: z.object({
    slug: z.string(),
    name: z.string(),
    /** Only owners receive enrollment credentials. */
    joinCode: z.string().nullable(),
    active: z.boolean(),
  }),
  teams: z.array(AdminTeamSummarySchema),
  /** Cohort members without a team yet. */
  unassigned: z.array(
    z.object({
      login: z.string(),
      name: z.string().nullable(),
      joinedAt: z.number().nullable(),
    }),
  ),
});
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;

/** PATCH /api/admin/cohort */
export const AdminCohortPatchSchema = z
  .object({
    /** Server generates the new code; the old one stops working. */
    rotateJoinCode: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .refine((b) => b.rotateJoinCode !== undefined || b.active !== undefined, {
    message: "Nothing to update.",
  });

/** POST /api/admin/teams/:teamId/members */
export const AdminAddMemberRequestSchema = z.object({
  login: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[a-zA-Z0-9-]+$/),
});

/** POST /api/admin/teams/:teamId/tas */
export const AdminAssignTaRequestSchema = AdminAddMemberRequestSchema;

/* ── Error envelope ───────────────────────────────────────────────────── */

export const API_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_request",
  "no_team",
  "no_cohort",
  "cohort_code_invalid",
  "quota_exhausted",
  "active_run_exists",
  "not_promotable",
  "not_selectable",
  "provider_unconfigured",
  "link_expired",
  "link_conflict",
  "authorization_pending",
  "invalid_token",
  "repo_access_required",
  "already_on_team",
  "not_in_cohort",
  "cannot_remove_creator",
  "user_not_found",
] as const;
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/* ── Constants ────────────────────────────────────────────────────────── */

export const PRACTICE_LIMIT = 10;
export const OFFICIAL_LIMIT = 3;
export const ACTIVE_RUN_POLL_MS = 2000; // plan §4: 2-second active-run polling
export const LOG_CAP_BYTES = 8 * 1024;
