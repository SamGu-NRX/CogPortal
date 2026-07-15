import {
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
    githubLogin: text("github_login").notNull().unique(),
    githubId: integer("github_id"),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    cohortId: text("cohort_id").references(() => cohorts.id),
    cohortJoinedAt: integer("cohort_joined_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("idx_users_github_id").on(table.githubId)],
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  oauthToken: text("oauth_token"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
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
  },
  (table) => [
    uniqueIndex("teams_cohort_repo_unique").on(table.cohortId, table.repoFullName),
    uniqueIndex("teams_discord_channel_unique").on(table.discordChannelId),
  ],
);

export const teamMembers = sqliteTable(
  "team_members",
  {
    teamId: text("team_id").notNull().references(() => teams.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role").notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.userId] })],
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
  parentRunId: text("parent_run_id"),
  attemptNumber: integer("attempt_number"),
  failureCategory: text("failure_category", {
    enum: [
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
    ],
  }),
  failurePhase: text("failure_phase", {
    enum: ["queued", "preparing", "installing", "contract_check", "evaluating", "scoring"],
  }),
  failureDetail: text("failure_detail"),
  failureConsumedAttempt: integer("failure_consumed_attempt", { mode: "boolean" })
    .notNull()
    .default(false),
  log: text("log"),
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
});

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
});

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
  teams,
  teamMembers,
  teamTas,
  benchmarks,
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
  runEvents,
  outboxEvents,
};

export type RunRow = typeof runs.$inferSelect;
export type BenchmarkRow = typeof benchmarks.$inferSelect;
export type TeamRow = typeof teams.$inferSelect;
