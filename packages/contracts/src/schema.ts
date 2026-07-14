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
    })
    .nullable(),
  cohort: z.object({ slug: z.string(), name: z.string() }).nullable(),
  team: TeamSchema.nullable(),
  auth: AuthConfigSchema,
});
export type Session = z.infer<typeof SessionSchema>;

/* ── Account connections and local reports ───────────────────────────── */

export const ConnectionSummarySchema = z.object({
  github: z.object({
    id: z.number().int().nullable(),
    login: z.string(),
    avatarUrl: z.string().nullable(),
  }),
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
  userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
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
  practiceUsed: z.number().int(),
  officialUsed: z.number().int(),
  /** Currently published primary metric value, when a selection exists. */
  publishedScore: z.number().nullable(),
});
export type AdminTeamSummary = z.infer<typeof AdminTeamSummarySchema>;

/** GET /api/admin/overview */
export const AdminOverviewSchema = z.object({
  cohort: z.object({
    slug: z.string(),
    name: z.string(),
    joinCode: z.string(),
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
