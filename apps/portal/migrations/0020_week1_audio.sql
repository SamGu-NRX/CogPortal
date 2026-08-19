-- Week 1 opens the audio track.
--
-- New id, not an edit of the inactive 'audio-recognition' seed row from
-- 0002_seed.sql. That row declares contract v1 and a 'recognition_accuracy'
-- metric that no scorer computes; this benchmark is v2 with a different
-- metric, so it is a different benchmark. Changing a contract or a metric on
-- an existing id is how a team's published number silently starts meaning
-- something else. The seed row stays inactive and untouched.
--
-- No benchmark_families row here, deliberately, for the same reason as
-- 0018_week3_language.sql. A family exists so the portal can combine metrics
-- from runs that no single scorer invocation ever sees together:
-- vision-overall spans vision-recognition and vision-clustering, two
-- independent runs, and only the portal knows which pair a team selected.
-- audio-identification is one run, and its scorer already reports
-- `identification_score` as the mean over the query grid's per-cell top-1
-- rates. Storing those weights again would put a second copy of that formula
-- in the Worker, in another language, free to drift from the scorer the next
-- time the grid changes.
--
-- The rule: the portal may aggregate across runs it alone can see. It must
-- not re-derive a number the scorer produced.
--
-- active = 0 on purpose. The row exists so the id, the versions, and the
-- primary metric key are pinned in one place, but calibration measured that
-- this grid does not rank: on the shipped evaluation manifest every pipeline
-- tried, including two deliberately crippled ones, scores between 0.475 and
-- 0.525 against seed noise of +/-0.013, and a peak-picker that is 4.7x worse
-- at real retrieval (0.200 vs 0.933 top-1 on half-second clips) scores
-- HIGHER on the primary. Four cells saturate at 1.000 for any fingerprint
-- pipeline and four sit at chance; nothing in between exists. A grid built
-- from the measured discriminating band is benchmark_version 2, not an edit
-- to this row. Flip active to 1 only when an ordering ablation passes
-- against genuinely bad parameters rather than against a strawman.
INSERT OR REPLACE INTO benchmarks (
  id, version, contract_version, entry_point_name, title, module, summary,
  active, primary_metric_key, plugin_version, dataset_version,
  scorer_version, runtime_version
) VALUES (
  'audio-identification', 1, 'cogworks.submissions.v2',
  'audio-identification', 'Song Identification', 'audio',
  'Enroll a catalog of songs, then identify short clips after noise, shortening, and pitch shift.',
  0, 'identification_score', '0.1.0', 'synth-v1',
  'identification-v1', 'week1-cpu-v1'
);
