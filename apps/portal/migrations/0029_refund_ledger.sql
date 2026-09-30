-- Count refunds so a cap can exist, and so an instructor can see one team
-- burning them.
--
-- A refund deletes the official_attempts row outright (worker/execution/sync.ts,
-- worker/execution/maintenance.ts, worker/routes/runner-events.ts). After that
-- delete the only surviving trace was the orphaned runs row, and nothing
-- counted it. So a submission that reliably provokes a platform-side failure
-- could be replayed without limit: each replay failed, each refund gave the
-- attempt back, and no surface anywhere showed it happening.
--
-- A column on runs rather than a new refunds table. The runs row already
-- carries team_id, benchmark_id, and benchmark_version, which is exactly the
-- grain the cap counts over, and it survives the officialAttempts delete. A
-- separate table would duplicate those three columns to record nothing the
-- run row does not already know, and would need its own cleanup when a run is
-- removed. The one thing a table would add is a history of refunds for a run
-- that was refunded more than once, and that cannot happen: a run reaches a
-- terminal state once, and the refund happens at that transition.
--
-- Null means "this run was never refunded", which is every run before this
-- migration. Those are not counted against any team, because we have no record
-- of which of them were refunded and guessing from failure_category would
-- credit teams with refunds they may never have received.
ALTER TABLE runs ADD COLUMN refunded_at INTEGER;

-- The cap query is "how many refunds does this team have on this benchmark",
-- run on every platform-caused official failure and once per team on the admin
-- overview. Without an index that is a scan of runs, which grows with every
-- practice run in the cohort. Partial, because refunds are a small minority of
-- rows and the query never asks about the nulls.
CREATE INDEX runs_refunded_team_benchmark_idx
  ON runs (team_id, benchmark_id, benchmark_version)
  WHERE refunded_at IS NOT NULL;
