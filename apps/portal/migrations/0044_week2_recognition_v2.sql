-- Week 2's recognition lifecycle now asks about the people already enrolled
-- after the stranger is enrolled as well as before, so its scorer version
-- moves.
--
-- It used to ask about them once, before the stranger arrived, and never
-- again. A submission that emptied its database whenever it learned a new
-- person therefore answered every question the benchmark asked and scored a
-- perfect 1.000. Half of each person's held-out photos are now asked on each
-- side of that enrollment, and the same submission scores 0.750.
--
-- The metrics and their arithmetic are unchanged: the same photos, the same
-- macro-average per person, the same denominators. What moved is where the
-- question is asked, and that is enough to move a number, which is what a
-- scorer version is for. A run page comparing a v1 number against a v2 one
-- would be comparing two different questions.
--
-- Unlike 0026, a published number can move here. Nothing in this migration
-- rewrites one: existing rows in `runs` keep scorer_version = 'recognition-v1',
-- which is what actually scored them, and only the catalog row changes.
UPDATE benchmarks
SET scorer_version = 'recognition-v2'
WHERE id = 'vision-recognition' AND version = 2;
