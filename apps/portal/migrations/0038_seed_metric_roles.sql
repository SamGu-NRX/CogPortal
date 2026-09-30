-- Give the seeded demo metrics a role, so the demo keeps its arrows.
--
-- The run page stopped claiming a direction for any run whose metrics carry no
-- roles at all, because in that state a floor and a scored metric arrive
-- indistinguishable and an arrow is a coin flip. The seed predates the column,
-- so every demo run lost its arrows too, on a branch whose whole purpose is
-- the demo.
--
-- These rows are fabricated fixture data, not a stored observation of a real
-- run, so naming them scored invents nothing about anybody's work. That is the
-- only reason this is safe here and not safe for real historical rows, which
-- 0035 deliberately left alone.
--
-- Guarded on role IS NULL so a re-seed that carries its own metadata wins.
UPDATE run_metrics
   SET role = 'scored'
 WHERE role IS NULL
   AND run_id IN (
     SELECT id FROM runs WHERE provider = 'fixture' AND id LIKE 'run_demo_%'
   );
