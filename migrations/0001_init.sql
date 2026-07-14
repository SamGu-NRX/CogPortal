PRAGMA foreign_keys = ON;

CREATE TABLE cohorts (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  join_code TEXT NOT NULL,
  active INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  github_login TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  cohort_id TEXT REFERENCES cohorts(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY NOT NULL,
  cohort_id TEXT NOT NULL REFERENCES cohorts(id),
  name TEXT NOT NULL,
  description TEXT,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  UNIQUE(cohort_id, repo_full_name)
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  PRIMARY KEY(team_id, user_id)
);

CREATE TABLE benchmarks (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  contract_version TEXT NOT NULL,
  entry_point_name TEXT NOT NULL,
  title TEXT NOT NULL,
  module TEXT NOT NULL,
  summary TEXT NOT NULL,
  active INTEGER NOT NULL,
  primary_metric_key TEXT NOT NULL,
  PRIMARY KEY(id, version)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  benchmark_id TEXT NOT NULL,
  benchmark_version INTEGER NOT NULL,
  contract_version TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  branch TEXT NOT NULL,
  sha TEXT NOT NULL,
  parent_run_id TEXT,
  attempt_number INTEGER,
  failure_category TEXT,
  failure_phase TEXT,
  failure_detail TEXT,
  failure_consumed_attempt INTEGER NOT NULL DEFAULT 0,
  log TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE run_phases (
  run_id TEXT NOT NULL REFERENCES runs(id),
  phase TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  PRIMARY KEY(run_id, phase)
);

CREATE TABLE run_metrics (
  run_id TEXT NOT NULL REFERENCES runs(id),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT,
  higher_is_better INTEGER NOT NULL,
  is_primary INTEGER NOT NULL,
  precision INTEGER NOT NULL,
  PRIMARY KEY(run_id, key)
);

CREATE TABLE official_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  benchmark_id TEXT NOT NULL,
  benchmark_version INTEGER NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  attempt_number INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER NOT NULL,
  UNIQUE(team_id, benchmark_id, benchmark_version, attempt_number)
);

CREATE TABLE leaderboard_selections (
  team_id TEXT NOT NULL REFERENCES teams(id),
  benchmark_id TEXT NOT NULL,
  benchmark_version INTEGER NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  selected_at INTEGER NOT NULL,
  PRIMARY KEY(team_id, benchmark_id, benchmark_version)
);
