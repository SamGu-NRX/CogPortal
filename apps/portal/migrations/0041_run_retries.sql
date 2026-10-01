ALTER TABLE runs ADD COLUMN retry_of_run_id TEXT REFERENCES runs(id);
ALTER TABLE runs ADD COLUMN dispatch_job_json TEXT;

DROP INDEX runs_surface_mode_unique;
CREATE UNIQUE INDEX runs_surface_mode_unique ON runs(surface_id, mode)
  WHERE retry_of_run_id IS NULL;
CREATE UNIQUE INDEX runs_retry_of_unique ON runs(retry_of_run_id);
