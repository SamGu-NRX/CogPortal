-- Whether a local report's weights_used_json is an answer or a placeholder.
--
-- 0033 added weights_used_json NOT NULL DEFAULT '[]'. ALTER TABLE fills
-- existing rows from the default, so every report synced before 0033 reads as
-- "used no weights", although the schema it was written under never recorded
-- the question. Dispatch took that '[]' at its word and sent a weighted
-- benchmark's run without its model. The reports themselves are not kept, so
-- the answer cannot be recovered; it can only be marked unknown.
--
-- A row is known when the stored value itself proves a weights-aware writer:
--   * weights_used_json is not '[]', which the default never produces;
--   * weights_uploaded_json is not NULL, which only a Worker with 0039 writes,
--     and that Worker's report schema has always required weightsUsed.
-- Every other row is unknown. That includes reports a weights-aware Worker
-- stored as a genuine '[]' between 0033 and this migration, because nothing
-- in the row tells them from a placeholder, and the migration timestamp does
-- not either: an old Worker can keep writing placeholders after 0033 applies
-- and before the new Worker deploys. Those teams run once more locally and
-- sync; dispatch says so (services/local-reports.ts, getLatestTeamWeights).
--
-- Reports synced after this migration are known: the Worker sets the flag on
-- every write, and the report schema requires weightsUsed.
ALTER TABLE local_reports ADD COLUMN weights_used_known INTEGER NOT NULL DEFAULT 0;
UPDATE local_reports
SET weights_used_known = 1
WHERE weights_used_json <> '[]' OR weights_uploaded_json IS NOT NULL;
