PRAGMA foreign_keys = ON;

-- Hand-applied staging seed. Never run this file as a migration.
-- It removes the six invented teams from 0002_seed.sql, then inserts archive
-- rows: real 2026 teams' measured scores under replaced names, with no
-- repository identity stored. The repository columns are NOT NULL, so they
-- hold the placeholder archive/<slug>, which links to nothing.

DELETE FROM run_stream_events
WHERE surface_id IN (SELECT id FROM run_surfaces WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
));
DELETE FROM local_run_sessions WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
);
DELETE FROM run_surfaces WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
);
DELETE FROM leaderboard_selections WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
);
DELETE FROM official_attempts WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
);
DELETE FROM run_events
WHERE run_id IN (SELECT id FROM runs WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
));
DELETE FROM run_metrics
WHERE run_id IN (SELECT id FROM runs WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
));
DELETE FROM run_phases
WHERE run_id IN (SELECT id FROM runs WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
));
DELETE FROM outbox_events
WHERE aggregate_id IN (SELECT id FROM runs WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
))
   OR aggregate_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
);
DELETE FROM setup_verifications WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
);
DELETE FROM team_nudges WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
);
DELETE FROM team_process_signals WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
);
DELETE FROM team_tas WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
);
DELETE FROM team_members WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
);
DELETE FROM runs WHERE team_id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
);
DELETE FROM teams WHERE id IN (
    'team_demo',
    'team_eigenfaces',
    'team_gradient',
    'team_manifold',
    'team_cosine',
    'team_latent',
    'team_archive_w1_a',
    'team_archive_w1_b',
    'team_archive_w1_c',
    'team_archive_w1_d',
    'team_archive_w2_a',
    'team_archive_w3_a',
    'team_archive_w3_b',
    'team_archive_w3_c'
);

INSERT INTO teams
  (id, cohort_id, name, description, repo_owner, repo_name, repo_full_name,
   repo_url, default_branch, repo_id, template_source_repo_id, discord_channel_id, provenance)
VALUES
  ('team_archive_w1_a', 'cohort_bwsi26', 'Week 1 team A',
   'A 2026 CogWorks team, scored after the course from the repository as they left it. Name replaced.',
   'archive', 'week-1-team-a', 'archive/week-1-team-a', '', 'main', NULL, NULL, NULL, 'archive'),
  ('team_archive_w1_b', 'cohort_bwsi26', 'Week 1 team B',
   'A 2026 CogWorks team, scored after the course from the repository as they left it. Name replaced.',
   'archive', 'week-1-team-b', 'archive/week-1-team-b', '', 'main', NULL, NULL, NULL, 'archive'),
  ('team_archive_w1_c', 'cohort_bwsi26', 'Week 1 team C',
   'A 2026 CogWorks team, scored after the course from the repository as they left it. Name replaced.',
   'archive', 'week-1-team-c', 'archive/week-1-team-c', '', 'main', NULL, NULL, NULL, 'archive'),
  ('team_archive_w1_d', 'cohort_bwsi26', 'Week 1 team D',
   'A 2026 CogWorks team, scored after the course from the repository as they left it. Name replaced.',
   'archive', 'week-1-team-d', 'archive/week-1-team-d', '', 'main', NULL, NULL, NULL, 'archive'),
  ('team_archive_w2_a', 'cohort_bwsi26', 'Week 2 team A',
   'A 2026 CogWorks team, scored after the course from the repository as they left it. Name replaced.',
   'archive', 'week-2-team-a', 'archive/week-2-team-a', '', 'main', NULL, NULL, NULL, 'archive'),
  ('team_archive_w3_a', 'cohort_bwsi26', 'Week 3 team A',
   'A 2026 CogWorks team, scored after the course from the repository as they left it. Name replaced.',
   'archive', 'week-3-team-a', 'archive/week-3-team-a', '', 'main', NULL, NULL, NULL, 'archive'),
  ('team_archive_w3_b', 'cohort_bwsi26', 'Week 3 team B',
   'A 2026 CogWorks team, scored after the course from the repository as they left it. Name replaced.',
   'archive', 'week-3-team-b', 'archive/week-3-team-b', '', 'main', NULL, NULL, NULL, 'archive'),
  ('team_archive_w3_c', 'cohort_bwsi26', 'Week 3 team C',
   'A 2026 CogWorks team, scored after the course from the repository as they left it. Name replaced.',
   'archive', 'week-3-team-c', 'archive/week-3-team-c', '', 'main', NULL, NULL, NULL, 'archive');

-- The sha column holds a digest of the scored commit, not the commit itself: a real
-- SHA resolves to its repository through GitHub search, which would undo the
-- anonymization the leaderboard promises. The digest-to-commit mapping and the
-- source of every metric value live in the owner's private copy of this file,
-- outside the repository. Run timestamps are the date the score was recorded.
INSERT INTO runs
  (id, team_id, benchmark_id, benchmark_version, contract_version, mode, status, branch, sha,
   parent_run_id, attempt_number, failure_category, failure_phase, failure_detail,
   failure_consumed_attempt, log, created_at, finished_at, provider, protocol_version,
   prepared_artifact_id, environment_digest, dataset_version, scorer_version, runtime_version,
   dispatch_attempts, last_event_sequence, surface_id, repository_id, diagnostics_json,
   sweep_json, wiring_json, refusal_json, refunded_at, weights_supplied_json)
VALUES
  ('run_archive_w1_a_audio', 'team_archive_w1_a', 'audio-identification', 1, 'cogworks.submissions.v2',
   'official', 'succeeded', 'main', 'a8baf8fc762c6c381563fb4d075d6769474994c8', NULL, 1, NULL, NULL, NULL, 0, NULL,
   1786924800000, 1786924800000, 'archive', '1', NULL, NULL, 'synth-v1', 'identification-v1',
   'week1-cpu-v1', 0, -1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'),
  ('run_archive_w1_b_audio', 'team_archive_w1_b', 'audio-identification', 1, 'cogworks.submissions.v2',
   'official', 'succeeded', 'main', '7462f51c59caaefdcaf38ccb32eccaab84883e8c', NULL, 1, NULL, NULL, NULL, 0, NULL,
   1786924800000, 1786924800000, 'archive', '1', NULL, NULL, 'synth-v1', 'identification-v1',
   'week1-cpu-v1', 0, -1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'),
  ('run_archive_w1_c_audio', 'team_archive_w1_c', 'audio-identification', 1, 'cogworks.submissions.v2',
   'official', 'succeeded', 'main', 'f3262ee6b97c0a0320c19e82281b51cc2f449ac6', NULL, 1, NULL, NULL, NULL, 0, NULL,
   1788390376000, 1788390376000, 'archive', '1', NULL, NULL, 'synth-v1', 'identification-v1',
   'week1-cpu-v1', 0, -1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'),
  ('run_archive_w1_d_audio', 'team_archive_w1_d', 'audio-identification', 1, 'cogworks.submissions.v2',
   'official', 'succeeded', 'main', '4235e1354b062f95533c7e429b1c6605687dc40f', NULL, 1, NULL, NULL, NULL, 0, NULL,
   1788390376000, 1788390376000, 'archive', '1', NULL, NULL, 'synth-v1', 'identification-v1',
   'week1-cpu-v1', 0, -1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'),
  ('run_archive_w2_a_cluster', 'team_archive_w2_a', 'vision-clustering', 2, 'cogworks.submissions.v2',
   'official', 'succeeded', 'main', '5c1bec9b514cc9589c4a98b30e07f472f2f8d79d', NULL, 1, NULL, NULL, NULL, 0, NULL,
   1788390376000, 1788390376000, 'archive', '1', NULL, NULL, 'celeba-official-v1', 'clustering-v2',
   'week2-cpu-v1', 0, -1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'),
  ('run_archive_w3_a_language', 'team_archive_w3_a', 'language-search', 1, 'cogworks.submissions.v2',
   'official', 'succeeded', 'main', '89d957d9cbef97922618233cdf90a760cd2ace99', NULL, 1, NULL, NULL, NULL, 0, NULL,
   1788390376000, 1788390376000, 'archive', '1', NULL, NULL, 'language-search-official-v1', 'retrieval-v4',
   'week3-cpu-v1', 0, -1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'),
  ('run_archive_w3_b_language', 'team_archive_w3_b', 'language-search', 1, 'cogworks.submissions.v2',
   'official', 'succeeded', 'main', 'e8baa2e2c4e20a2e263a03a5294787b3ddc61316', NULL, 1, NULL, NULL, NULL, 0, NULL,
   1788390376000, 1788390376000, 'archive', '1', NULL, NULL, 'language-search-official-v1', 'retrieval-v4',
   'week3-cpu-v1', 0, -1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'),
  ('run_archive_w3_c_language', 'team_archive_w3_c', 'language-search', 1, 'cogworks.submissions.v2',
   'official', 'succeeded', 'main', '970d1b6a51ef28b53a3abfcf6937ec0d86c3fe8e', NULL, 1, NULL, NULL, NULL, 0, NULL,
   1788390376000, 1788390376000, 'archive', '1', NULL, NULL, 'language-search-official-v1', 'retrieval-v4',
   'week3-cpu-v1', 0, -1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'),
  ('run_archive_w3_d_language', 'team_archive_w1_c', 'language-search', 1, 'cogworks.submissions.v2',
   'official', 'succeeded', 'main', 'f3262ee6b97c0a0320c19e82281b51cc2f449ac6', NULL, 1, NULL, NULL, NULL, 0, NULL,
   1788390376000, 1788390376000, 'archive', '1', NULL, NULL, 'language-search-official-v1', 'retrieval-v4',
   'week3-cpu-v1', 0, -1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]');

INSERT INTO run_phases (run_id, phase, started_at, ended_at) VALUES
  ('run_archive_w1_a_audio', 'scoring', 1786924800000, 1786924800000),
  ('run_archive_w1_b_audio', 'scoring', 1786924800000, 1786924800000),
  ('run_archive_w1_c_audio', 'scoring', 1788390376000, 1788390376000),
  ('run_archive_w1_d_audio', 'scoring', 1788390376000, 1788390376000),
  ('run_archive_w2_a_cluster', 'scoring', 1788390376000, 1788390376000),
  ('run_archive_w3_a_language', 'scoring', 1788390376000, 1788390376000),
  ('run_archive_w3_b_language', 'scoring', 1788390376000, 1788390376000),
  ('run_archive_w3_c_language', 'scoring', 1788390376000, 1788390376000),
  ('run_archive_w3_d_language', 'scoring', 1788390376000, 1788390376000);

INSERT INTO run_metrics
  (run_id, key, label, value, unit, higher_is_better, is_primary, precision, help)
VALUES
  ('run_archive_w1_a_audio', 'identification_score', 'Identification score', 0.5375, NULL, 1, 1, 4, NULL),
  ('run_archive_w1_a_audio', 'clean_top1', 'Clean top-1', 1.000, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_a_audio', 'noisy_top1', 'Noisy top-1', 1.000, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_a_audio', 'short_clip_top1', 'Short clip top-1', 1.000, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_a_audio', 'pitch_top1', 'Pitch-shifted top-1', 0.08, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_a_audio', 'median_identify_seconds', 'Median identify time', 0.046, NULL, 0, 0, 3, NULL);

INSERT INTO run_metrics
  (run_id, key, label, value, unit, higher_is_better, is_primary, precision, help)
VALUES
  ('run_archive_w1_b_audio', 'identification_score', 'Identification score', 0.5292, NULL, 1, 1, 4, NULL),
  ('run_archive_w1_b_audio', 'clean_top1', 'Clean top-1', 1.000, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_b_audio', 'noisy_top1', 'Noisy top-1', 1.000, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_b_audio', 'short_clip_top1', 'Short clip top-1', 1.000, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_b_audio', 'pitch_top1', 'Pitch-shifted top-1', 0.06, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_b_audio', 'median_identify_seconds', 'Median identify time', 3.03, NULL, 0, 0, 3, NULL);

INSERT INTO run_metrics
  (run_id, key, label, value, unit, higher_is_better, is_primary, precision, help)
VALUES
  ('run_archive_w1_c_audio', 'identification_score', 'Identification score', 0.547, NULL, 1, 1, 4, NULL),
  ('run_archive_w1_c_audio', 'clean_top1', 'Clean top-1', 1.0, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_c_audio', 'noisy_top1', 'Noisy top-1', 1.0, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_c_audio', 'short_clip_top1', 'Short clip top-1', 1.0, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_c_audio', 'pitch_top1', 'Pitch-shifted top-1', 0.094, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_c_audio', 'retrieval_failure_rate', 'No candidate found', 0.188, NULL, 0, 0, 3, NULL),
  ('run_archive_w1_c_audio', 'ranking_failure_rate', 'Wrong song ranked first', 0.0, NULL, 0, 0, 3, NULL);

INSERT INTO run_metrics
  (run_id, key, label, value, unit, higher_is_better, is_primary, precision, help)
VALUES
  ('run_archive_w1_d_audio', 'identification_score', 'Identification score', 0.5156, NULL, 1, 1, 4, NULL),
  ('run_archive_w1_d_audio', 'clean_top1', 'Clean top-1', 1.0, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_d_audio', 'noisy_top1', 'Noisy top-1', 0.875, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_d_audio', 'short_clip_top1', 'Short clip top-1', 1.0, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_d_audio', 'pitch_top1', 'Pitch-shifted top-1', 0.0625, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_d_audio', 'retrieval_failure_rate', 'No candidate found', 0.4844, NULL, 0, 0, 3, NULL),
  ('run_archive_w1_d_audio', 'ranking_failure_rate', 'Wrong song ranked first', 0.0, NULL, 0, 0, 3, NULL),
  ('run_archive_w1_d_audio', 'chance_top1', 'Chance', 0.125, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_d_audio', 'trivial_baseline_top1', 'Trivial baseline', 0.375, NULL, 1, 0, 3, NULL),
  ('run_archive_w1_d_audio', 'median_identify_seconds', 'Median identify time', 0.0245, NULL, 0, 0, 3, NULL);

INSERT INTO run_metrics
  (run_id, key, label, value, unit, higher_is_better, is_primary, precision, help)
VALUES
  ('run_archive_w2_a_cluster', 'clustering_pairwise_f1', 'Pairwise F1', 0.909, NULL, 1, 1, 4, NULL),
  ('run_archive_w2_a_cluster', 'adjusted_rand_index', 'Adjusted Rand index', 0.879, NULL, 1, 0, 3, NULL),
  ('run_archive_w2_a_cluster', 'clustering_seed_spread', 'Spread across seeds', 0.0, NULL, 0, 0, 3, NULL);

INSERT INTO run_metrics
  (run_id, key, label, value, unit, higher_is_better, is_primary, precision, help)
VALUES
  ('run_archive_w3_a_language', 'overall', 'Overall', 0.6792, NULL, 1, 1, 4, NULL),
  ('run_archive_w3_a_language', 'text_mrr', 'Text MRR', 0.87, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_a_language', 'retrieval_mrr', 'Retrieval MRR', 0.5838, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_a_language', 'search_mrr', 'Search MRR', 0.5838, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_a_language', 'retrieval_recall_at_1', 'Recall@1', 0.6, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_a_language', 'retrieval_recall_at_5', 'Recall@5', 0.8, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_a_language', 'retrieval_recall_at_10', 'Recall@10', 0.9, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_a_language', 'retrieval_median_rank', 'Median rank', 1, NULL, 0, 0, 3, NULL),
  ('run_archive_w3_a_language', 'chance_mrr', 'Chance MRR', 0.0519, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_a_language', 'text_chance', 'Text chance MRR', 0.1721, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_a_language', 'search_chance', 'Search chance MRR', 0.045, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_a_language', 'search_mrr_verbatim', 'Search MRR, caption unchanged (not scored)', 0.677, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_a_language', 'search_mrr_keywords', 'Search MRR, keywords only', 0.6157, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_a_language', 'search_mrr_truncated', 'Search MRR, first three words', 0.532, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_a_language', 'search_mrr_typo', 'Search MRR, one typo', 0.6037, NULL, 1, 0, 3, NULL);

INSERT INTO run_metrics
  (run_id, key, label, value, unit, higher_is_better, is_primary, precision, help)
VALUES
  ('run_archive_w3_b_language', 'overall', 'Overall', 0.3512, NULL, 1, 1, 4, NULL),
  ('run_archive_w3_b_language', 'text_mrr', 'Text MRR', 0.7836, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_b_language', 'retrieval_mrr', 'Retrieval MRR', 0.1366, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_b_language', 'search_mrr', 'Search MRR', 0.1334, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_b_language', 'chance_mrr', 'Chance MRR', 0.0102, NULL, 1, 0, 3, NULL);

INSERT INTO run_metrics
  (run_id, key, label, value, unit, higher_is_better, is_primary, precision, help)
VALUES
  ('run_archive_w3_c_language', 'overall', 'Overall', 0.3228, NULL, 1, 1, 4, NULL),
  ('run_archive_w3_c_language', 'text_mrr', 'Text MRR', 0.87, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_c_language', 'retrieval_mrr', 'Retrieval MRR', 0.0515, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_c_language', 'search_mrr', 'Search MRR', 0.0468, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_c_language', 'retrieval_recall_at_1', 'Recall@1', 0.0, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_c_language', 'retrieval_median_rank', 'Median rank', 38.5, NULL, 0, 0, 3, NULL),
  ('run_archive_w3_c_language', 'text_chance', 'Text chance MRR', 0.1721, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_c_language', 'chance_mrr', 'Chance MRR', 0.0519, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_c_language', 'search_chance', 'Search chance MRR', 0.045, NULL, 1, 0, 3, NULL);

INSERT INTO run_metrics
  (run_id, key, label, value, unit, higher_is_better, is_primary, precision, help)
VALUES
  ('run_archive_w3_d_language', 'overall', 'Overall', 0.3437, NULL, 1, 1, 4, NULL),
  ('run_archive_w3_d_language', 'text_mrr', 'Text MRR', 0.9152, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_d_language', 'retrieval_mrr', 'Retrieval MRR', 0.0606, NULL, 1, 0, 3, NULL),
  ('run_archive_w3_d_language', 'search_mrr', 'Search MRR', 0.0554, NULL, 1, 0, 3, NULL);

INSERT INTO official_attempts
  (id, team_id, benchmark_id, benchmark_version, run_id, attempt_number, consumed, claimed_at)
VALUES
  ('attempt_archive_w1_a_audio', 'team_archive_w1_a', 'audio-identification', 1, 'run_archive_w1_a_audio', 1, 1, 1786924800000),
  ('attempt_archive_w1_b_audio', 'team_archive_w1_b', 'audio-identification', 1, 'run_archive_w1_b_audio', 1, 1, 1786924800000),
  ('attempt_archive_w1_c_audio', 'team_archive_w1_c', 'audio-identification', 1, 'run_archive_w1_c_audio', 1, 1, 1788390376000),
  ('attempt_archive_w1_d_audio', 'team_archive_w1_d', 'audio-identification', 1, 'run_archive_w1_d_audio', 1, 1, 1788390376000),
  ('attempt_archive_w2_a_cluster', 'team_archive_w2_a', 'vision-clustering', 2, 'run_archive_w2_a_cluster', 1, 1, 1788390376000),
  ('attempt_archive_w3_a_language', 'team_archive_w3_a', 'language-search', 1, 'run_archive_w3_a_language', 1, 1, 1788390376000),
  ('attempt_archive_w3_b_language', 'team_archive_w3_b', 'language-search', 1, 'run_archive_w3_b_language', 1, 1, 1788390376000),
  ('attempt_archive_w3_c_language', 'team_archive_w3_c', 'language-search', 1, 'run_archive_w3_c_language', 1, 1, 1788390376000),
  ('attempt_archive_w3_d_language', 'team_archive_w1_c', 'language-search', 1, 'run_archive_w3_d_language', 1, 1, 1788390376000);

INSERT INTO leaderboard_selections
  (team_id, benchmark_id, benchmark_version, run_id, selected_at)
VALUES
  ('team_archive_w1_a', 'audio-identification', 1, 'run_archive_w1_a_audio', 1786924800000),
  ('team_archive_w1_b', 'audio-identification', 1, 'run_archive_w1_b_audio', 1786924800000),
  ('team_archive_w1_c', 'audio-identification', 1, 'run_archive_w1_c_audio', 1788390376000),
  ('team_archive_w1_d', 'audio-identification', 1, 'run_archive_w1_d_audio', 1788390376000),
  ('team_archive_w2_a', 'vision-clustering', 2, 'run_archive_w2_a_cluster', 1788390376000),
  ('team_archive_w3_a', 'language-search', 1, 'run_archive_w3_a_language', 1788390376000),
  ('team_archive_w3_b', 'language-search', 1, 'run_archive_w3_b_language', 1788390376000),
  ('team_archive_w3_c', 'language-search', 1, 'run_archive_w3_c_language', 1788390376000),
  ('team_archive_w1_c', 'language-search', 1, 'run_archive_w3_d_language', 1788390376000);
