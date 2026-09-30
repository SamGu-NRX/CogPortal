-- Which benchmark a setup check was about.
--
-- Two of the four machine steps are per-benchmark: the install line names one
-- distribution, and `cogworks check --benchmark X` wires one benchmark's entry
-- points. The evidence was keyed (user, team, step) with no room to say which,
-- so a student who set up Audio and then switched the page to Language was
-- told Language's benchmark was installed and wired. Nobody had run it.
--
-- Empty string, not NULL, because it is part of the primary key: SQLite treats
-- NULLs as distinct in a unique index, so a NULL here would let the same step
-- be recorded without limit. Empty means "no benchmark recorded", which is
-- what every existing row genuinely is and what an older CLI still sends.
-- Those rows stay readable and stop being counted toward any single track,
-- which is the overclaim this removes; re-running `check` records a scoped
-- row beside them.
-- No PRAGMA defer_foreign_keys here because no table references
-- setup_verifications. A rebuild of a table that is referenced needs it, the
-- way 0014_better_auth.sql does.
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
