-- Enforce at most one active (non-terminal) run per team+benchmark. Prevents
-- the single-active-run and practice-quota TOCTOU where two concurrent starts
-- both pass the read-then-insert check and both insert. The partial unique
-- index makes the second concurrent active insert fail, which the run-start
-- paths map to a clean 409 "active_run_exists".
CREATE UNIQUE INDEX runs_one_active_per_team_benchmark
  ON runs (team_id, benchmark_id)
  WHERE status IN (
    'queued',
    'preparing',
    'installing',
    'contract_check',
    'evaluating',
    'scoring'
  );
