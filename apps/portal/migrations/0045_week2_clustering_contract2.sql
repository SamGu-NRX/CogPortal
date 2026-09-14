-- Contract 2 declares a clustering decoder that preserves scored/scenario_key.
-- The sandbox runs every case; the controller scores its retained gold-bearing
-- cases. Recognition keeps contract 1, and historical results remain unchanged.
--
-- Follow 0042's coordinated transition: close intake, drain admitted requests,
-- queue retries and active executions, update the matching runner and catalog,
-- then verify compatibility before reopening. No fixed timeout proves a drain.
UPDATE benchmarks
SET sandbox_contract = 2
WHERE id = 'vision-clustering' AND version = 2;
