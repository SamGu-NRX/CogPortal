-- Which CLI command wrote a synced local report: 'test' (the smoke-test
-- cases) or 'run' (the practice set). NULL is a report synced before the CLI
-- recorded it, shown as unrecorded rather than guessed. None of the existing
-- JSON columns is an object that could carry it.
ALTER TABLE local_reports ADD COLUMN command TEXT CHECK (command IN ('test', 'run'));
