-- Failed executions no longer consume quota; retain historical refund values only.
DROP INDEX IF EXISTS runs_refunded_team_benchmark_idx;
