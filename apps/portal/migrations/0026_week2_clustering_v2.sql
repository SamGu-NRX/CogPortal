-- Week 2's clustering scorer reports how far the answer moved across random
-- seeds, so its version moves.
--
-- Whispers picks a random visit order. Every manifest pinned one seed, so a
-- submission whose answer swings between draws scored whatever that draw gave.
-- The scorer now re-clusters the same photos under three more fixed seeds and
-- reports the spread, which is a new metric and therefore a new version: a run
-- page comparing a v1 run against a v2 one would show a blank row instead.
--
-- The two scored metrics are unchanged, and only the manifest's own seed
-- counts toward them, so no published number moves. Existing rows in `runs`
-- keep scorer_version = 'clustering-v1', which is what actually scored them.
UPDATE benchmarks
SET scorer_version = 'clustering-v2'
WHERE id = 'vision-clustering' AND version = 2;
