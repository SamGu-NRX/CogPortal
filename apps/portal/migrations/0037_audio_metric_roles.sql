-- The Audio floors stop claiming a direction.
--
-- run_bb29405e29 and every other stored Audio result draws "higher is better"
-- on `chance_top1` and `trivial_baseline_top1`. Both are properties of the
-- corpus: chance is 1/N for a catalog of N songs, and the trivial baseline is
-- a whole-clip nearest neighbour that does none of the capstone. Telling a
-- student to raise either is telling them to change the dataset. 0035 added
-- the columns that carry the correction but deliberately backfilled nothing,
-- so those rows still make the claim.
--
-- This is not an invention. The Week 1 plugin now declares the same four keys
-- through `metric_roles` and `metric_relations`, and that declaration changed
-- no formula: `benchmark_version` is still 1 and `scorer_version` is still
-- `identification-v1` before and after, which is the repository's own test for
-- "the number means what it meant" (scripts/validate_week1_submodule.py). The
-- rows below were produced by that scorer version, so the producer's statement
-- about what those keys are applies to them exactly.
--
-- Scoped three ways on purpose: to this benchmark, to the version whose plugin
-- makes the claim, and to rows that have no role recorded. A run that reported
-- its own metadata is never overwritten, and no other benchmark is touched.
-- Week 3's historical rows have the same problem and are NOT repaired here:
-- it has shipped more than one scorer version, so a single mapping cannot be
-- shown to apply to all of its stored rows.
UPDATE run_metrics
   SET role = 'floor', relates_to = 'identification_score'
 WHERE role IS NULL
   AND key IN ('chance_top1', 'trivial_baseline_top1')
   AND run_id IN (
     SELECT id FROM runs
      WHERE benchmark_id = 'audio-identification' AND benchmark_version = 1
   );

-- "Reported as its own labeled column and deliberately kept out of the primary
-- metric" (margin_auc) and "Reported, never scored" (median identify time).
UPDATE run_metrics
   SET role = 'reported'
 WHERE role IS NULL
   AND key IN ('margin_separation', 'median_identify_seconds')
   AND run_id IN (
     SELECT id FROM runs
      WHERE benchmark_id = 'audio-identification' AND benchmark_version = 1
   );
