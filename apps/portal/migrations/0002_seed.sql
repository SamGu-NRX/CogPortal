-- Every database takes this file, hosted ones included, so it carries only
-- what a hosted deployment needs: the benchmark catalog that later migrations
-- build on, and the one cohort the admin console manages (it cannot create
-- one). The join code is random because a code published in this repository
-- would admit anyone; an owner reads or rotates it in the admin console.
--
-- The demo teams and runs that used to live here are in
-- scripts/seed-local.sql, which only `pnpm db:seed:local` applies. Hosted
-- databases that ran the earlier version of this file keep their rows:
-- wrangler records migrations by filename and never runs one twice.

INSERT INTO cohorts (id, slug, name, join_code, active) VALUES
  ('cohort_bwsi26', 'bwsi-2026', 'BWSI CogWorks 2026', upper(hex(randomblob(4))), 1);

INSERT INTO benchmarks
  (id, version, contract_version, entry_point_name, title, module, summary, active, primary_metric_key)
VALUES
  ('vision-recognition', 1, 'cogworks.submissions.v1', 'vision-recognition', 'Face Recognition', 'vision',
   'Enroll reference faces, then identify known people and reject unknown faces in held-out images.', 1, 'recognition_f1'),
  ('vision-clustering', 1, 'cogworks.submissions.v1', 'vision-clustering', 'Whispers Clustering', 'vision',
   'Awaiting partition-metric specification.', 0, 'partition_score'),
  ('audio-recognition', 1, 'cogworks.submissions.v1', 'audio-recognition', 'Song Recognition', 'audio',
   'Identify songs from short held-out audio excerpts.', 0, 'recognition_accuracy'),
  ('language-search', 1, 'cogworks.submissions.v1', 'language-search', 'Semantic Image Search', 'language',
   'Retrieve images whose content best matches a natural-language query.', 0, 'retrieval_map');
