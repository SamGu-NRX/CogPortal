ALTER TABLE teams ADD COLUMN discord_channel_id TEXT;

CREATE UNIQUE INDEX teams_discord_channel_unique
  ON teams(discord_channel_id)
  WHERE discord_channel_id IS NOT NULL;

CREATE TABLE local_run_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL REFERENCES cli_devices(id),
  benchmark_id TEXT NOT NULL,
  benchmark_version INTEGER NOT NULL,
  repository_id INTEGER,
  repository_full_name TEXT NOT NULL,
  sha TEXT NOT NULL,
  dirty INTEGER NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  failure_detail TEXT,
  report_id TEXT REFERENCES local_reports(report_id),
  discord_channel_id TEXT,
  discord_message_id TEXT,
  last_event_sequence INTEGER NOT NULL DEFAULT -1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX local_run_sessions_team_created_idx
  ON local_run_sessions(team_id, created_at DESC);
