-- Week 3 opens the language track.
--
-- No benchmark_families row here, deliberately. A family exists so the portal
-- can combine metrics from runs that no single scorer invocation ever sees
-- together: vision-overall spans vision-recognition and vision-clustering,
-- two independent runs, and only the portal knows which pair a team selected.
-- language-search is one run, and its scorer already reports `overall` as the
-- mean of the three component MRRs. Storing those weights again would put a
-- second copy of that formula in the Worker, in another language, free to
-- drift from the scorer the next time the formula changes.
--
-- The rule, for whoever adds the audio track: the portal may aggregate across
-- runs it alone can see. It must not re-derive a number the scorer produced.
INSERT OR REPLACE INTO benchmarks (
  id, version, contract_version, entry_point_name, title, module, summary,
  active, primary_metric_key, plugin_version, dataset_version,
  scorer_version, runtime_version
) VALUES (
  'language-search', 1, 'cogworks.submissions.v2',
  'language-search', 'Semantic Image Search', 'language',
  'Caption-to-image retrieval with your trained encoder in the caption-embedding space.',
  1, 'overall', '0.1.0', 'language-search-official-v1',
  'retrieval-v1', 'week3-cpu-v1'
);
