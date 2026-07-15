CREATE TABLE run_surfaces (
  id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  benchmark_id TEXT NOT NULL,
  benchmark_version INTEGER NOT NULL,
  local_run_id TEXT,
  supersedes_surface_id TEXT,
  discord_channel_id TEXT,
  discord_message_id TEXT,
  discord_nonce_generation INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX run_surfaces_local_run_unique
  ON run_surfaces(local_run_id)
  WHERE local_run_id IS NOT NULL;
CREATE UNIQUE INDEX run_surfaces_supersedes_unique
  ON run_surfaces(supersedes_surface_id)
  WHERE supersedes_surface_id IS NOT NULL;
CREATE INDEX run_surfaces_team_updated_idx
  ON run_surfaces(team_id, updated_at DESC);

CREATE TABLE run_stream_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  surface_id TEXT NOT NULL REFERENCES run_surfaces(id),
  source TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  phase TEXT NOT NULL,
  code TEXT NOT NULL,
  elapsed_ms INTEGER,
  progress_current INTEGER,
  progress_total INTEGER,
  progress_unit TEXT,
  occurred_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX run_stream_events_source_sequence_unique
  ON run_stream_events(source, source_run_id, source_sequence);
CREATE INDEX run_stream_events_surface_time_idx
  ON run_stream_events(surface_id, occurred_at DESC);

ALTER TABLE local_run_sessions ADD COLUMN branch TEXT;
ALTER TABLE local_run_sessions ADD COLUMN surface_id TEXT;
CREATE UNIQUE INDEX local_run_sessions_surface_unique
  ON local_run_sessions(surface_id)
  WHERE surface_id IS NOT NULL;

ALTER TABLE runs ADD COLUMN surface_id TEXT;
CREATE UNIQUE INDEX runs_surface_mode_unique
  ON runs(surface_id, mode)
  WHERE surface_id IS NOT NULL;
