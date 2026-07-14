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
  },
  (table) => [
    uniqueIndex("teams_cohort_repo_unique").on(table.cohortId, table.repoFullName),
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
  benchmarks,
  runs,
  runPhases,
  runMetrics,
  officialAttempts,
  leaderboardSelections,
};

export type RunRow = typeof runs.$inferSelect;
export type BenchmarkRow = typeof benchmarks.$inferSelect;
export type TeamRow = typeof teams.$inferSelect;
