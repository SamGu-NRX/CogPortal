-- Gives back the quota held by Week 2 recognition runs that the scorer
-- correction in 0044 left behind.
--
-- 0044 changed vision-recognition version 2's scorer to recognition-v2
-- without changing the version. Runs already scored kept scorer_version
-- 'recognition-v1', which is what actually scored them, so the board stopped
-- ranking them while they still counted against the team's three official
-- attempts and ten practice runs. A team that had used them could not run
-- under the corrected scorer at all.
--
-- refunded_at is the capacity-release timestamp: a succeeded execution with
-- one set no longer counts as used (run-accounting.ts acceptedRunPredicate)
-- and cannot be promoted or published. An active execution still holds its
-- reservation until it ends, so an old run that is still going keeps blocking
-- a concurrent start, and if it completes later it does not acquire a charge,
-- because completion never clears refunded_at.
--
-- Nothing else moves: ids, statuses, scores, scorer stamps, attempt numbers,
-- leaderboard selections and the official_attempts ledger stay as they are.
-- Failed and cancelled runs never counted, so they are left alone. A row that
-- was already refunded keeps its original time. Running this twice changes
-- nothing the second time.
UPDATE runs
SET refunded_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE benchmark_id = 'vision-recognition'
  AND benchmark_version = 2
  AND scorer_version = 'recognition-v1'
  AND refunded_at IS NULL
  AND status IN ('succeeded', 'queued', 'preparing', 'installing', 'contract_check', 'evaluating', 'scoring');
