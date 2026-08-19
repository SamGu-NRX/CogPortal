-- Week 3's scorer reports three new metrics, so its version moves.
--
-- The metric set is part of what a scorer version means: `search_mrr_keywords`,
-- `search_mrr_truncated`, `search_mrr_typo`, and `text_chance` did not exist
-- under retrieval-v1, and a run page comparing a v1 run against a v2 one would
-- show four blank rows with no explanation for them.
--
-- `overall` is deliberately unchanged. It still averages the same three
-- component MRRs and still comes out at 0.4329 for the reference on the
-- evaluation tier, so no published number moves. The new metrics sit beside it
-- and say which part of the capstone is load-bearing.
--
-- Existing rows in `runs` keep scorer_version = 'retrieval-v1'. That column
-- records what actually scored a run, and rewriting it would claim those runs
-- reported metrics they never computed.
UPDATE benchmarks
SET scorer_version = 'retrieval-v2'
WHERE id = 'language-search' AND version = 1;
