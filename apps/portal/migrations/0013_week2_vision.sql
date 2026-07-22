ALTER TABLE runs ADD COLUMN repository_id INTEGER;

UPDATE benchmarks
SET active = 0
WHERE id IN ('vision-recognition', 'vision-clustering') AND version = 1;

INSERT OR REPLACE INTO benchmarks (
  id, version, contract_version, entry_point_name, title, module, summary,
  active, primary_metric_key, plugin_version, dataset_version,
  scorer_version, runtime_version
) VALUES
  (
    'vision-recognition', 2, 'cogworks.submissions.v2',
    'vision-recognition', 'Recognition', 'vision',
    'Known-person identification and the unknown-person enrollment lifecycle.',
    1, 'recognition_score', '0.1.0', 'celeba-official-v1',
    'recognition-v1', 'week2-cpu-v1'
  ),
  (
    'vision-clustering', 2, 'cogworks.submissions.v2',
    'vision-clustering', 'Clustering', 'vision',
    'Permutation-invariant Whispers clustering over one-face image sets.',
    1, 'clustering_pairwise_f1', '0.1.0', 'celeba-official-v1',
    'clustering-v1', 'week2-cpu-v1'
  );

CREATE TABLE benchmark_families (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  module TEXT NOT NULL CHECK (module IN ('vision', 'audio', 'language')),
  active INTEGER NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE benchmark_family_components (
  family_id TEXT NOT NULL,
  family_version INTEGER NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  benchmark_id TEXT NOT NULL,
  benchmark_version INTEGER NOT NULL,
  metric_key TEXT NOT NULL,
  weight REAL NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (family_id, family_version, key)
);

INSERT INTO benchmark_families (id, version, title, module, active)
VALUES ('vision-overall', 1, 'Vision Overall', 'vision', 1);

INSERT INTO benchmark_family_components (
  family_id, family_version, key, label, benchmark_id, benchmark_version,
  metric_key, weight, sort_order
) VALUES
  (
    'vision-overall', 1, 'known_identification', 'Known identification',
    'vision-recognition', 2, 'known_identification', 0.3333333333333333, 1
  ),
  (
    'vision-overall', 1, 'unknown_lifecycle', 'Unknown lifecycle',
    'vision-recognition', 2, 'unknown_lifecycle', 0.3333333333333333, 2
  ),
  (
    'vision-overall', 1, 'clustering_pairwise_f1', 'Clustering pairwise F1',
    'vision-clustering', 2, 'clustering_pairwise_f1', 0.3333333333333333, 3
  );
