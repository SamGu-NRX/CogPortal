-- Metric metadata the scorer already sends and the portal was dropping.
--
-- `role` and `relatesTo` ride the callback payload (packages/contracts
-- protocol.ts) and the run page already understands them: a metric declared
-- `floor` renders without a direction arrow, because a dataset floor is a
-- property of the data rather than something a submission did well or badly
-- at. Neither field had a column, so both writers dropped them and every
-- stored floor came back looking like a scored metric.
--
-- Nothing already stored changes: role is written when a result arrives, so
-- every run on the portal today keeps role NULL and keeps drawing whatever it
-- drew. Only runs executed after this deploys render their floors correctly.
--
-- Nullable with no backfill and no default. A row written before this
-- migration genuinely has no recorded role, and deriving one from a key or
-- from today's plugin definitions would be inventing evidence for a run
-- nobody can re-observe. Absent stays absent.
ALTER TABLE run_metrics ADD COLUMN role TEXT;
ALTER TABLE run_metrics ADD COLUMN relates_to TEXT;
