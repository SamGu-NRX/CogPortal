-- Environment, package, and wiring checks belong to the benchmark checked.
-- Preserve older evidence without assigning it to a track nobody recorded.
-- Empty string keeps the primary key non-null, so repeated unscoped checks
-- still update one row. No table references setup_verifications.
CREATE TABLE setup_verifications_scoped (
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  step TEXT NOT NULL,
  benchmark_id TEXT NOT NULL DEFAULT '',
  verified_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, team_id, step, benchmark_id)
);

INSERT INTO setup_verifications_scoped (user_id, team_id, step, benchmark_id, verified_at)
  SELECT user_id, team_id, step, '', verified_at FROM setup_verifications;

DROP TABLE setup_verifications;
ALTER TABLE setup_verifications_scoped RENAME TO setup_verifications;
