ALTER TABLE users ADD COLUMN cohort_joined_at INTEGER;
UPDATE cohorts SET join_code = UPPER(join_code);
