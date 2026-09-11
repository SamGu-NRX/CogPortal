import type { MetricRole } from "@cogworks/contracts/schema";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const cohorts = sqliteTable("cohorts", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  joinCode: text("join_code").notNull(),
  active: integer("active", { mode: "boolean" }).notNull(),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .default(false)
      .notNull(),
    image: text("image"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    githubLogin: text("github_login"),
    githubId: integer("github_id"),
    avatarUrl: text("avatar_url"),
    cohortId: text("cohort_id").references(() => cohorts.id),
    cohortJoinedAt: integer("cohort_joined_at"),
  },
  (table) => [uniqueIndex("idx_users_github_login").on(table.githubLogin)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("sessions_userId_idx").on(table.userId)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("accounts_userId_idx").on(table.userId),
    uniqueIndex("accounts_provider_account_unique").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

export const rateLimits = sqliteTable("rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});

export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey(),
    cohortId: text("cohort_id").notNull().references(() => cohorts.id),
    name: text("name").notNull(),
    description: text("description"),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    repoFullName: text("repo_full_name").notNull(),
    repoUrl: text("repo_url").notNull(),
    defaultBranch: text("default_branch").notNull(),
    repoId: integer("repo_id"),
    templateSourceRepoId: integer("template_source_repo_id"),
    discordChannelId: text("discord_channel_id"),
    /** The leaderboard must label rows the pipeline did not produce for a living team. */
    provenance: text("provenance", { enum: ["live", "archive"] })
      .notNull()
      .default("live"),
  },
  (table) => [
    uniqueIndex("teams_cohort_repo_unique").on(table.cohortId, table.repoFullName),
    uniqueIndex("teams_discord_channel_unique").on(table.discordChannelId),
  ],
);

/**
 * What we have already told a team, so the five-minute cron says a thing once.
 * The kind is part of the key: a team should still hear a different
 * observation later, but never the same sentence twice.
 */
export const teamNudges = sqliteTable(
  "team_nudges",
  {
    teamId: text("team_id").notNull().references(() => teams.id),
    kind: text("kind").notNull(),
    sentAt: integer("sent_at").notNull(),
    detail: text("detail"),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.kind] })],
);

/**
 * The last computed process signals for a team (stage footprint, first
 * light, boundary churn, ownership breadth) -- see
 * `worker/services/process-signals.ts` for what those are and
 * `worker/routes/team.ts` for the 30-minute recompute cadence. One row per
 * team, always replaced as a whole: `historyQuality` is pulled out of
 * `signalsJson` into its own column only so a future query can filter by it
 * without parsing JSON in SQL.
 */
export const teamProcessSignals = sqliteTable("team_process_signals", {
  teamId: text("team_id").primaryKey().references(() => teams.id),
  computedAt: integer("computed_at").notNull(),
  signalsJson: text("signals_json").notNull(),
  historyQuality: text("history_quality").notNull(),
});

export const teamMembers = sqliteTable(
  "team_members",
  {
    teamId: text("team_id").notNull().references(() => teams.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.userId] }),
    /** One team per student — closes the concurrent-join race (0011). */
    uniqueIndex("team_members_user_unique").on(table.userId),
  ],
);

export const teamTas = sqliteTable(
  "team_tas",
  {
    teamId: text("team_id").notNull().references(() => teams.id),
    userId: text("user_id").notNull().references(() => users.id),
    assignedAt: integer("assigned_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.userId] })],
);

/**
 * Platform staff roster, owner-managed at runtime (migration 0031).
 *
 * Keyed on the lowercased login because GitHub logins are case-insensitive and
 * this replaces an env list that was compared case-insensitively. Owners are
 * NOT in this table; they stay in PLATFORM_OWNER_LOGINS so a writable roster
 * can never mint an owner, and so an empty table still has somebody who can
 * add the first row.
 */
export const platformStaff = sqliteTable("platform_staff", {
  /** Lowercased GitHub login. The only value ever compared. */
  login: text("login").primaryKey(),
  /** The casing the owner typed, so the roster reads back as entered. */
  displayLogin: text("display_login").notNull(),
  /** Granting owner's login, stored as text: an audit row must outlive the
   *  granter's account, so this is deliberately not a foreign key. */
  grantedBy: text("granted_by").notNull(),
  grantedAt: integer("granted_at").notNull(),
});

export const setupVerifications = sqliteTable(
  "setup_verifications",
  {
    userId: text("user_id").notNull().references(() => users.id),
    teamId: text("team_id").notNull().references(() => teams.id),
    step: text("step").notNull(),
    /**
     * The benchmark this evidence is about, or "" when it is not about one.
     *
     * `clone` and `environment` are the same fact whatever track is selected,
     * so they are always stored unscoped. `project` and `wiring` name one
     * distribution and one set of wired entry points, so they are stored
     * against the benchmark the CLI checked. An older CLI sends no benchmark
     * and its rows stay "", which no longer satisfies a per-track claim
     * (migration 0036).
     */
    benchmarkId: text("benchmark_id").notNull().default(""),
    verifiedAt: integer("verified_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.teamId, table.step, table.benchmarkId] }),
  ],
);

export const benchmarks = sqliteTable(
  "benchmarks",
  {
    id: text("id").notNull(),
    version: integer("version").notNull(),
    contractVersion: text("contract_version").notNull(),
    entryPointName: text("entry_point_name").notNull(),
    title: text("title").notNull(),
    module: text("module", { enum: ["vision", "audio", "language"] }).notNull(),
    summary: text("summary").notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    primaryMetricKey: text("primary_metric_key").notNull(),
    pluginVersion: text("plugin_version").notNull().default("0.1.0"),
    datasetVersion: text("dataset_version").notNull().default("practice-v1"),
    scorerVersion: text("scorer_version").notNull().default("1"),
    runtimeVersion: text("runtime_version").notNull().default("python-3.11"),
  },
  (table) => [primaryKey({ columns: [table.id, table.version] })],
);

export const benchmarkFamilies = sqliteTable(
  "benchmark_families",
  {
    id: text("id").notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    module: text("module", { enum: ["vision", "audio", "language"] }).notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.version] })],
);

export const benchmarkFamilyComponents = sqliteTable(
  "benchmark_family_components",
  {
    familyId: text("family_id").notNull(),
    familyVersion: integer("family_version").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    benchmarkId: text("benchmark_id").notNull(),
    benchmarkVersion: integer("benchmark_version").notNull(),
    metricKey: text("metric_key").notNull(),
    weight: real("weight").notNull(),
    sortOrder: integer("sort_order").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.familyId, table.familyVersion, table.key] }),
  ],
);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull().references(() => teams.id),
  benchmarkId: text("benchmark_id").notNull(),
  benchmarkVersion: integer("benchmark_version").notNull(),
  contractVersion: text("contract_version").notNull(),
  mode: text("mode", { enum: ["practice", "official"] }).notNull(),
  status: text("status", {
    enum: [
      "queued",
      "preparing",
      "installing",
      "contract_check",
      "evaluating",
      "scoring",
      "succeeded",
      "failed",
      "cancelled",
    ],
  }).notNull(),
  branch: text("branch").notNull(),
  sha: text("sha").notNull(),
  repositoryId: integer("repository_id"),
  parentRunId: text("parent_run_id"),
  attemptNumber: integer("attempt_number"),
  failureCategory: text("failure_category", {
    enum: [
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
    ],
  }),
  failurePhase: text("failure_phase", {
    enum: ["queued", "preparing", "installing", "contract_check", "evaluating", "scoring"],
  }),
  failureDetail: text("failure_detail"),
  failureConsumedAttempt: integer("failure_consumed_attempt", { mode: "boolean" })
    .notNull()
    .default(false),
  /** When this run's official attempt was given back because the failure was
   *  ours (migration 0029). Null for every run that was never refunded,
   *  including every run from before the column existed. Counting these per
   *  team and benchmark is what the refund cap reads; see
   *  worker/execution/refunds.ts. */
  refundedAt: integer("refunded_at"),
  log: text("log"),
  /** Scorer diagnostics from the succeeded event: the benchmark's own
   *  explanation of what a submission got wrong. JSON array of strings. */
  diagnosticsJson: text("diagnostics_json"),
  /** Which of the team's own functions ran, when the platform found them
   *  itself. Null when the repository declared its own submission. */
  wiringJson: text("wiring_json"),
  /** Why nothing could be found to score. Null for every other failure:
   *  their code raising is theirs to read, and the log is where it belongs. */
  refusalJson: text("refusal_json"),
  /** The scorer's difficulty sweep, as JSON. Null when the benchmark has no
   *  difficulty knob, or when the run predates migration 0023. */
  sweepJson: text("sweep_json"),
  /** Repository-relative weight paths present in this run's prepared snapshot. */
  weightsSuppliedJson: text("weights_supplied_json").notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
  provider: text("provider", { enum: ["fixture", "modal"] }).notNull().default("fixture"),
  protocolVersion: text("protocol_version").notNull().default("1"),
  preparedArtifactId: text("prepared_artifact_id"),
  environmentDigest: text("environment_digest"),
  datasetVersion: text("dataset_version").notNull().default("practice-v1"),
  scorerVersion: text("scorer_version").notNull().default("1"),
  runtimeVersion: text("runtime_version").notNull().default("python-3.11"),
  dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
  lastEventSequence: integer("last_event_sequence").notNull().default(-1),
  surfaceId: text("surface_id"),
}, (table) => [
  // Enforce the quota check across concurrent run starts (migration 0015).
  uniqueIndex("runs_one_active_per_team_benchmark")
    .on(table.teamId, table.benchmarkId)
    .where(
      sql`${table.status} IN ('queued','preparing','installing','contract_check','evaluating','scoring')`,
    ),
  // The refund cap counts refunds per team and benchmark on every
  // platform-caused official failure (migration 0029). Partial, because
  // refunds are a small minority of runs and the count never asks about the
  // nulls.
  index("runs_refunded_team_benchmark_idx")
    .on(table.teamId, table.benchmarkId, table.benchmarkVersion)
    .where(sql`${table.refundedAt} IS NOT NULL`),
]);

export const templateSources = sqliteTable("template_sources", {
  id: text("id").primaryKey(),
  benchmarkId: text("benchmark_id").notNull(),
  sourceRepoId: integer("source_repo_id").notNull().unique(),
  fullName: text("full_name").notNull(),
  minimumSdkVersion: text("minimum_sdk_version").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
});

export const discordAccounts = sqliteTable(
  "discord_accounts",
  {
    discordUserId: text("discord_user_id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    username: text("username").notNull(),
    linkedAt: integer("linked_at").notNull(),
  },
  (table) => [uniqueIndex("discord_accounts_user_unique").on(table.userId)],
);

export const accountLinkTokens = sqliteTable("account_link_tokens", {
  id: text("id").primaryKey(),
  purpose: text("purpose", { enum: ["discord"] }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  discordUserId: text("discord_user_id"),
  discordUsername: text("discord_username"),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
  createdAt: integer("created_at").notNull(),
});

export const deviceAuthorizations = sqliteTable("device_authorizations", {
  deviceCodeHash: text("device_code_hash").primaryKey(),
  userCode: text("user_code").notNull().unique(),
  userId: text("user_id").references(() => users.id),
  deviceName: text("device_name"),
  expiresAt: integer("expires_at").notNull(),
  approvedAt: integer("approved_at"),
  consumedAt: integer("consumed_at"),
  createdAt: integer("created_at").notNull(),
});

export const cliDevices = sqliteTable("cli_devices", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
});

export const localReports = sqliteTable("local_reports", {
  reportId: text("report_id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  benchmarkId: text("benchmark_id").notNull(),
  benchmarkVersion: integer("benchmark_version").notNull(),
  contractVersion: text("contract_version").notNull(),
  sdkVersion: text("sdk_version").notNull(),
  pluginVersion: text("plugin_version").notNull(),
  repositoryId: integer("repository_id"),
  repositoryFullName: text("repository_full_name"),
  sha: text("sha"),
  dirty: integer("dirty", { mode: "boolean" }).notNull(),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at").notNull(),
  metricsJson: text("metrics_json").notNull(),
  diagnosticsJson: text("diagnostics_json").notNull(),
  /** Paths discovery read while producing this local report. */
  weightsUsedJson: text("weights_used_json").notNull().default("[]"),
  /** Required uploads; NULL preserves unknown provenance on legacy reports. */
  weightsUploadedJson: text("weights_uploaded_json"),
  syncedAt: integer("synced_at").notNull(),
});

export const localRunSessions = sqliteTable("local_run_sessions", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull().references(() => teams.id),
  userId: text("user_id").notNull().references(() => users.id),
  deviceId: text("device_id").notNull().references(() => cliDevices.id),
  benchmarkId: text("benchmark_id").notNull(),
  benchmarkVersion: integer("benchmark_version").notNull(),
  repositoryId: integer("repository_id"),
  repositoryFullName: text("repository_full_name").notNull(),
  sha: text("sha").notNull(),
  branch: text("branch"),
  dirty: integer("dirty", { mode: "boolean" }).notNull(),
  status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull(),
  phase: text("phase", {
    enum: ["preparing", "contract_check", "evaluating", "scoring"],
  }).notNull(),
  failureDetail: text("failure_detail"),
  reportId: text("report_id").references(() => localReports.reportId),
  discordChannelId: text("discord_channel_id"),
  discordMessageId: text("discord_message_id"),
  lastEventSequence: integer("last_event_sequence").notNull().default(-1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  finishedAt: integer("finished_at"),
  surfaceId: text("surface_id"),
});

export const runSurfaces = sqliteTable(
  "run_surfaces",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => teams.id),
    createdByUserId: text("created_by_user_id").notNull().references(() => users.id),
    benchmarkId: text("benchmark_id").notNull(),
    benchmarkVersion: integer("benchmark_version").notNull(),
    localRunId: text("local_run_id"),
    supersedesSurfaceId: text("supersedes_surface_id"),
    discordChannelId: text("discord_channel_id"),
    discordMessageId: text("discord_message_id"),
    discordNonceGeneration: integer("discord_nonce_generation").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("run_surfaces_local_run_unique").on(table.localRunId),
    uniqueIndex("run_surfaces_supersedes_unique").on(table.supersedesSurfaceId),
  ],
);

export const runStreamEvents = sqliteTable(
  "run_stream_events",
  {
    eventId: text("event_id").primaryKey(),
    surfaceId: text("surface_id").notNull().references(() => runSurfaces.id),
    source: text("source", { enum: ["local", "practice", "official", "system"] }).notNull(),
    sourceRunId: text("source_run_id").notNull(),
    sourceSequence: integer("source_sequence").notNull(),
    phase: text("phase").notNull(),
    code: text("code").notNull(),
    elapsedMs: integer("elapsed_ms"),
    progressCurrent: integer("progress_current"),
    progressTotal: integer("progress_total"),
    progressUnit: text("progress_unit", { enum: ["cases", "items"] }),
    occurredAt: integer("occurred_at").notNull(),
  },
  (table) => [
    uniqueIndex("run_stream_events_source_sequence_unique").on(
      table.source,
      table.sourceRunId,
      table.sourceSequence,
    ),
  ],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    eventId: text("event_id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    receivedAt: integer("received_at").notNull(),
  },
  (table) => [uniqueIndex("run_events_run_sequence_unique").on(table.runId, table.sequence)],
);

export const outboxEvents = sqliteTable("outbox_events", {
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: integer("created_at").notNull(),
  deliveredAt: integer("delivered_at"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at").notNull(),
});

export const runPhases = sqliteTable(
  "run_phases",
  {
    runId: text("run_id").notNull().references(() => runs.id),
    phase: text("phase", {
      enum: ["queued", "preparing", "installing", "contract_check", "evaluating", "scoring"],
    }).notNull(),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
  },
  (table) => [primaryKey({ columns: [table.runId, table.phase] })],
);

export const runMetrics = sqliteTable(
  "run_metrics",
  {
    runId: text("run_id").notNull().references(() => runs.id),
    key: text("key").notNull(),
    label: text("label").notNull(),
    value: real("value").notNull(),
    unit: text("unit"),
    higherIsBetter: integer("higher_is_better", { mode: "boolean" }).notNull(),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull(),
    precision: integer("precision").notNull(),
    /**
     * What this metric measures, in the course's vocabulary. Stored per run
     * rather than per benchmark on purpose: the explanation belongs to the
     * scorer version that produced the number, so an old run keeps the words
     * that were true when it ran.
     */
    help: text("help"),
    /**
     * What kind of number this is, when the scorer says. "floor" is the one
     * that matters today: a chance baseline is a fact about the dataset, so
     * the run page shows it without a direction arrow.
     *
     * Written when a result arrives, from what that scorer declared. One
     * exception: 0037 filled it in for Week 1 Audio rows from the plugin's own
     * declaration, which was safe there because the scorer version did not
     * move. Null still means nothing was recorded, which is not the same as
     * "ordinary", and 0035 backfills nothing on its own.
     */
    role: text("role").$type<MetricRole>(),
    /** The key of the metric this one is about, for a floor or a companion
     *  measure that only means something beside its parent. */
    relatesTo: text("relates_to"),
  },
  (table) => [primaryKey({ columns: [table.runId, table.key] })],
);

export const officialAttempts = sqliteTable(
  "official_attempts",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => teams.id),
    benchmarkId: text("benchmark_id").notNull(),
    benchmarkVersion: integer("benchmark_version").notNull(),
    runId: text("run_id").notNull().unique(),
    attemptNumber: integer("attempt_number").notNull(),
    consumed: integer("consumed", { mode: "boolean" }).notNull().default(false),
    claimedAt: integer("claimed_at").notNull(),
  },
  (table) => [
    uniqueIndex("official_attempts_team_benchmark_attempt_unique").on(
      table.teamId,
      table.benchmarkId,
      table.benchmarkVersion,
      table.attemptNumber,
    ),
  ],
);

export const leaderboardSelections = sqliteTable(
  "leaderboard_selections",
  {
    teamId: text("team_id").notNull().references(() => teams.id),
    benchmarkId: text("benchmark_id").notNull(),
    benchmarkVersion: integer("benchmark_version").notNull(),
    runId: text("run_id").notNull().references(() => runs.id),
    selectedAt: integer("selected_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.benchmarkId, table.benchmarkVersion] })],
);

export const schema = {
  cohorts,
  users,
  sessions,
  accounts,
  verifications,
  rateLimits,
  teams,
  teamMembers,
  teamTas,
  platformStaff,
  setupVerifications,
  benchmarks,
  benchmarkFamilies,
  benchmarkFamilyComponents,
  runs,
  runPhases,
  runMetrics,
  officialAttempts,
  leaderboardSelections,
  templateSources,
  discordAccounts,
  accountLinkTokens,
  deviceAuthorizations,
  cliDevices,
  localReports,
  localRunSessions,
  runSurfaces,
  runStreamEvents,
  runEvents,
  outboxEvents,
  teamProcessSignals,
};

export type TeamProcessSignalsRow = typeof teamProcessSignals.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type BenchmarkRow = typeof benchmarks.$inferSelect;
export type TeamRow = typeof teams.$inferSelect;
export type RunSurfaceRow = typeof runSurfaces.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type VerificationRow = typeof verifications.$inferSelect;
