ALTER TABLE local_reports ADD COLUMN weights_used_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE runs ADD COLUMN weights_supplied_json TEXT NOT NULL DEFAULT '[]';
