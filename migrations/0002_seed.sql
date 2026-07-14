INSERT INTO cohorts (id, slug, name, join_code, active) VALUES
  ('cohort_bwsi26', 'bwsi-2026', 'BWSI CogWorks 2026', 'VISION26', 1);

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

INSERT INTO teams
  (id, cohort_id, name, description, repo_owner, repo_name, repo_full_name, repo_url, default_branch)
VALUES
  ('team_demo', 'cohort_bwsi26', 'Vector Voyagers', 'Robust recognition under difficult lighting.',
   'cogworks-demo', 'face-finder', 'cogworks-demo/face-finder', 'https://github.com/cogworks-demo/face-finder', 'main'),
  ('team_eigenfaces', 'cohort_bwsi26', 'Eigenfaces United', 'Strong embeddings with calibrated rejection.',
   'cogworks-demo', 'eigenfaces-united', 'cogworks-demo/eigenfaces-united', 'https://github.com/cogworks-demo/eigenfaces-united', 'main'),
  ('team_gradient', 'cohort_bwsi26', 'Gradient Descenders', 'Small models, careful thresholds.',
   'cogworks-demo', 'gradient-descenders', 'cogworks-demo/gradient-descenders', 'https://github.com/cogworks-demo/gradient-descenders', 'main'),
  ('team_manifold', 'cohort_bwsi26', 'Manifold Destiny', 'Geometry-minded face recognition.',
   'cogworks-demo', 'manifold-destiny', 'cogworks-demo/manifold-destiny', 'https://github.com/cogworks-demo/manifold-destiny', 'main'),
  ('team_cosine', 'cohort_bwsi26', 'Cosine Similarity Club', 'Normalized descriptors and transparent baselines.',
   'cogworks-demo', 'cosine-similarity-club', 'cogworks-demo/cosine-similarity-club', 'https://github.com/cogworks-demo/cosine-similarity-club', 'main'),
  ('team_latent', 'cohort_bwsi26', 'Latent Space Cadets', 'Compact representations for reliable matching.',
   'cogworks-demo', 'latent-space-cadets', 'cogworks-demo/latent-space-cadets', 'https://github.com/cogworks-demo/latent-space-cadets', 'main');

INSERT INTO runs
  (id, team_id, benchmark_id, benchmark_version, contract_version, mode, status, branch, sha,
   parent_run_id, attempt_number, failure_category, failure_phase, failure_detail,
   failure_consumed_attempt, log, created_at, finished_at)
VALUES
  ('run_demo_p1', 'team_demo', 'vision-recognition', 1, 'cogworks.submissions.v1', 'practice', 'succeeded', 'main',
   '1111111111111111111111111111111111111111', NULL, NULL, NULL, NULL, NULL, 0,
   'Resolved ref refs/heads/main -> 1111111111111111111111111111111111111111\ncontract check: 6/6 methods OK\nscorer summary: recognition_f1=0.8750',
   1783900000000, 1783900021200),
  ('run_demo_fail', 'team_demo', 'vision-recognition', 1, 'cogworks.submissions.v1', 'practice', 'failed', 'heavy-model',
   '2222222222222222222222222222222222222222', NULL, NULL, 'timeout', 'evaluating',
   'Process exceeded 900 s wall time and was terminated (SIGKILL after grace).', 0,
   'Resolved ref refs/heads/heavy-model -> 2222222222222222222222222222222222222222\ncontract check: 6/6 methods OK\nrunner: process killed (SIGKILL)\nProcess exceeded 900 s wall time and was terminated (SIGKILL after grace).',
   1783903600000, 1783903619300),
  ('run_demo_p2', 'team_demo', 'vision-recognition', 1, 'cogworks.submissions.v1', 'practice', 'succeeded', 'improved-thresholds',
   '3333333333333333333333333333333333333333', NULL, NULL, NULL, NULL, NULL, 0,
   'Resolved ref refs/heads/improved-thresholds -> 3333333333333333333333333333333333333333\ncontract check: 6/6 methods OK\nscorer summary: recognition_f1=0.8930',
   1783907200000, 1783907221200),
  ('run_demo_o1', 'team_demo', 'vision-recognition', 1, 'cogworks.submissions.v1', 'official', 'succeeded', 'improved-thresholds',
   '3333333333333333333333333333333333333333', 'run_demo_p2', 1, NULL, NULL, NULL, 0, NULL,
   1783910800000, 1783910821200),
  ('run_ghost_eigen', 'team_eigenfaces', 'vision-recognition', 1, 'cogworks.submissions.v1', 'official', 'succeeded', 'main',
   'a111111111111111111111111111111111111111', NULL, 1, NULL, NULL, NULL, 0, NULL,
   1783890000000, 1783890021200),
  ('run_ghost_gradient', 'team_gradient', 'vision-recognition', 1, 'cogworks.submissions.v1', 'official', 'succeeded', 'main',
   'b222222222222222222222222222222222222222', NULL, 1, NULL, NULL, NULL, 0, NULL,
   1783891000000, 1783891021200),
  ('run_ghost_manifold', 'team_manifold', 'vision-recognition', 1, 'cogworks.submissions.v1', 'official', 'succeeded', 'main',
   'c333333333333333333333333333333333333333', NULL, 1, NULL, NULL, NULL, 0, NULL,
   1783892000000, 1783892021200),
  ('run_ghost_cosine', 'team_cosine', 'vision-recognition', 1, 'cogworks.submissions.v1', 'official', 'succeeded', 'main',
   'd444444444444444444444444444444444444444', NULL, 1, NULL, NULL, NULL, 0, NULL,
   1783893000000, 1783893021200),
  ('run_ghost_latent', 'team_latent', 'vision-recognition', 1, 'cogworks.submissions.v1', 'official', 'succeeded', 'main',
   'e555555555555555555555555555555555555555', NULL, 1, NULL, NULL, NULL, 0, NULL,
   1783894000000, 1783894021200);

INSERT INTO run_phases (run_id, phase, started_at, ended_at) VALUES
  ('run_demo_p1', 'queued', 1783900000000, 1783900001200),
  ('run_demo_p1', 'preparing', 1783900001200, 1783900004700),
  ('run_demo_p1', 'installing', 1783900004700, 1783900009900),
  ('run_demo_p1', 'contract_check', 1783900009900, 1783900011700),
  ('run_demo_p1', 'evaluating', 1783900011700, 1783900019300),
  ('run_demo_p1', 'scoring', 1783900019300, 1783900021200),
  ('run_demo_fail', 'queued', 1783903600000, 1783903601200),
  ('run_demo_fail', 'preparing', 1783903601200, 1783903604700),
  ('run_demo_fail', 'installing', 1783903604700, 1783903609900),
  ('run_demo_fail', 'contract_check', 1783903609900, 1783903611700),
  ('run_demo_fail', 'evaluating', 1783903611700, 1783903619300),
  ('run_demo_fail', 'scoring', NULL, NULL),
  ('run_demo_p2', 'queued', 1783907200000, 1783907201200),
  ('run_demo_p2', 'preparing', 1783907201200, 1783907204700),
  ('run_demo_p2', 'installing', 1783907204700, 1783907209900),
  ('run_demo_p2', 'contract_check', 1783907209900, 1783907211700),
  ('run_demo_p2', 'evaluating', 1783907211700, 1783907219300),
  ('run_demo_p2', 'scoring', 1783907219300, 1783907221200),
  ('run_demo_o1', 'queued', 1783910800000, 1783910801200),
  ('run_demo_o1', 'preparing', 1783910801200, 1783910804700),
  ('run_demo_o1', 'installing', 1783910804700, 1783910809900),
  ('run_demo_o1', 'contract_check', 1783910809900, 1783910811700),
  ('run_demo_o1', 'evaluating', 1783910811700, 1783910819300),
  ('run_demo_o1', 'scoring', 1783910819300, 1783910821200);

INSERT INTO run_metrics
  (run_id, key, label, value, unit, higher_is_better, is_primary, precision)
VALUES
  ('run_demo_p1', 'recognition_f1', 'Recognition F1', 0.8750, NULL, 1, 1, 3),
  ('run_demo_p1', 'detection_recall', 'Detection recall', 0.9310, NULL, 1, 0, 3),
  ('run_demo_p1', 'unknown_rejection', 'Unknown rejection', 0.8420, NULL, 1, 0, 3),
  ('run_demo_p1', 'mean_latency_ms', 'Mean latency', 318, 'ms', 0, 0, 0),
  ('run_demo_p2', 'recognition_f1', 'Recognition F1', 0.8930, NULL, 1, 1, 3),
  ('run_demo_p2', 'detection_recall', 'Detection recall', 0.9440, NULL, 1, 0, 3),
  ('run_demo_p2', 'unknown_rejection', 'Unknown rejection', 0.8610, NULL, 1, 0, 3),
  ('run_demo_p2', 'mean_latency_ms', 'Mean latency', 301, 'ms', 0, 0, 0),
  ('run_demo_o1', 'recognition_f1', 'Recognition F1', 0.8890, NULL, 1, 1, 3),
  ('run_demo_o1', 'detection_recall', 'Detection recall', 0.9410, NULL, 1, 0, 3),
  ('run_demo_o1', 'unknown_rejection', 'Unknown rejection', 0.8540, NULL, 1, 0, 3),
  ('run_demo_o1', 'mean_latency_ms', 'Mean latency', 304, 'ms', 0, 0, 0),
  ('run_ghost_eigen', 'recognition_f1', 'Recognition F1', 0.9180, NULL, 1, 1, 3),
  ('run_ghost_eigen', 'detection_recall', 'Detection recall', 0.9620, NULL, 1, 0, 3),
  ('run_ghost_eigen', 'unknown_rejection', 'Unknown rejection', 0.8870, NULL, 1, 0, 3),
  ('run_ghost_eigen', 'mean_latency_ms', 'Mean latency', 276, 'ms', 0, 0, 0),
  ('run_ghost_gradient', 'recognition_f1', 'Recognition F1', 0.9020, NULL, 1, 1, 3),
  ('run_ghost_gradient', 'detection_recall', 'Detection recall', 0.9510, NULL, 1, 0, 3),
  ('run_ghost_gradient', 'unknown_rejection', 'Unknown rejection', 0.8730, NULL, 1, 0, 3),
  ('run_ghost_gradient', 'mean_latency_ms', 'Mean latency', 248, 'ms', 0, 0, 0),
  ('run_ghost_manifold', 'recognition_f1', 'Recognition F1', 0.8970, NULL, 1, 1, 3),
  ('run_ghost_manifold', 'detection_recall', 'Detection recall', 0.9470, NULL, 1, 0, 3),
  ('run_ghost_manifold', 'unknown_rejection', 'Unknown rejection', 0.8660, NULL, 1, 0, 3),
  ('run_ghost_manifold', 'mean_latency_ms', 'Mean latency', 291, 'ms', 0, 0, 0),
  ('run_ghost_cosine', 'recognition_f1', 'Recognition F1', 0.8810, NULL, 1, 1, 3),
  ('run_ghost_cosine', 'detection_recall', 'Detection recall', 0.9360, NULL, 1, 0, 3),
  ('run_ghost_cosine', 'unknown_rejection', 'Unknown rejection', 0.8490, NULL, 1, 0, 3),
  ('run_ghost_cosine', 'mean_latency_ms', 'Mean latency', 259, 'ms', 0, 0, 0),
  ('run_ghost_latent', 'recognition_f1', 'Recognition F1', 0.8740, NULL, 1, 1, 3),
  ('run_ghost_latent', 'detection_recall', 'Detection recall', 0.9290, NULL, 1, 0, 3),
  ('run_ghost_latent', 'unknown_rejection', 'Unknown rejection', 0.8380, NULL, 1, 0, 3),
  ('run_ghost_latent', 'mean_latency_ms', 'Mean latency', 283, 'ms', 0, 0, 0);

INSERT INTO official_attempts
  (id, team_id, benchmark_id, benchmark_version, run_id, attempt_number, consumed, claimed_at)
VALUES
  ('attempt_demo_1', 'team_demo', 'vision-recognition', 1, 'run_demo_o1', 1, 1, 1783910800000);

INSERT INTO leaderboard_selections
  (team_id, benchmark_id, benchmark_version, run_id, selected_at)
VALUES
  ('team_demo', 'vision-recognition', 1, 'run_demo_o1', 1783910900000),
  ('team_eigenfaces', 'vision-recognition', 1, 'run_ghost_eigen', 1783890100000),
  ('team_gradient', 'vision-recognition', 1, 'run_ghost_gradient', 1783891100000),
  ('team_manifold', 'vision-recognition', 1, 'run_ghost_manifold', 1783892100000),
  ('team_cosine', 'vision-recognition', 1, 'run_ghost_cosine', 1783893100000),
  ('team_latent', 'vision-recognition', 1, 'run_ghost_latent', 1783894100000);
