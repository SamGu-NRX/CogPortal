-- The approved identity of an official dataset version's bytes, and the copy
-- each official run was sent with. A run used to record only the version name,
-- and the 2026-10-02 provenance audit replaced a bundle under an unchanged name
-- and scored overall 1.0 and then 0.61 with identical records.
--
-- benchmarks.dataset_digest is SHA-256 of the scored files in the
-- cogworks.dataset-digest.v1 form (apps/runner-modal/tools/dataset_digest.py
-- prints it). NULL means not approved, and official admission refuses it
-- before any compute. This migration approves nothing: each digest is
-- registered by its own reviewed migration from the published volume copy
-- (docs/runbooks/platform.md).
--
-- runs.dataset_digest is frozen with the dispatch job. NULL on every run
-- before this migration and on every practice run, so a historical record
-- still reads as it did and is never given a digest it was not checked against.
ALTER TABLE benchmarks ADD COLUMN dataset_digest TEXT
  CHECK (dataset_digest IS NULL OR (length(dataset_digest) = 64 AND dataset_digest NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE runs ADD COLUMN dataset_digest TEXT
  CHECK (dataset_digest IS NULL OR (length(dataset_digest) = 64 AND dataset_digest NOT GLOB '*[^0-9a-f]*'));
