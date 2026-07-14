ALTER TABLE teams ADD COLUMN repo_id INTEGER;
ALTER TABLE teams ADD COLUMN template_source_id INTEGER;

ALTER TABLE benchmarks ADD COLUMN plugin_version TEXT NOT NULL DEFAULT '0.1.0';
ALTER TABLE benchmarks ADD COLUMN dataset_version TEXT NOT NULL DEFAULT 'practice-v1';
ALTER TABLE benchmarks ADD COLUMN scorer_version TEXT NOT NULL DEFAULT '1';
ALTER TABLE benchmarks ADD COLUMN runtime_version TEXT NOT NULL DEFAULT 'python-3.11';

ALTER TABLE runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'fixture';
ALTER TABLE runs ADD COLUMN protocol_version TEXT NOT NULL DEFAULT '1';
ALTER TABLE runs ADD COLUMN prepared_artifact_id TEXT;
ALTER TABLE runs ADD COLUMN environment_digest TEXT;
ALTER TABLE runs ADD COLUMN dataset_version TEXT NOT NULL DEFAULT 'practice-v1';
ALTER TABLE runs ADD COLUMN scorer_version TEXT NOT NULL DEFAULT '1';
ALTER TABLE runs ADD COLUMN runtime_version TEXT NOT NULL DEFAULT 'python-3.11';
ALTER TABLE runs ADD COLUMN dispatch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN last_event_sequence INTEGER NOT NULL DEFAULT -1;

CREATE TABLE template_sources (
  id TEXT PRIMARY KEY NOT NULL,
  benchmark_id TEXT NOT NULL,
  source_repo_id INTEGER NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  minimum_sdk_version TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE discord_accounts (
  discord_user_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  linked_at INTEGER NOT NULL
);

CREATE TABLE account_link_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  discord_user_id TEXT,
  discord_username TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE device_authorizations (
  device_code_hash TEXT PRIMARY KEY NOT NULL,
  user_code TEXT NOT NULL UNIQUE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE cli_devices (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE local_reports (
  report_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  benchmark_id TEXT NOT NULL,
  benchmark_version INTEGER NOT NULL,
  contract_version TEXT NOT NULL,
  sdk_version TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  repository_id INTEGER,
  repository_full_name TEXT,
  sha TEXT,
  dirty INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  metrics_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  synced_at INTEGER NOT NULL
);

CREATE INDEX idx_local_reports_user_benchmark
  ON local_reports(user_id, benchmark_id, synced_at DESC);

CREATE TABLE run_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE(run_id, sequence)
);

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY NOT NULL,
  topic TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL
);

CREATE INDEX idx_outbox_pending
  ON outbox_events(delivered_at, next_attempt_at);
