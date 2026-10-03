-- Two fields that let the stale-run sweep judge an execution by what the
-- runner last said rather than by when it started.
--
-- accepted_activity_at is the server time of the last runner callback that
-- advanced an active execution's sequence. Replays, lower sequences and late
-- results for an already failed run do not move it, so it is not
-- run_events.received_at, which records every callback including ignored ones.
--
-- legacy_grace_until is for executions already running when this ships. They
-- have no recorded activity, and failing them by age alone is what this
-- replaces. NULL means such a row that maintenance has not reached yet; the
-- first sweep that would fail it gives it one inactivity window instead
-- (maintenance.ts), once. New executions write 0, meaning no grace.
--
-- No backfill, and no default: an old row stays NULL in both until the
-- runner or the sweep says something about it. Apply this before deploying
-- the Worker that reads these columns, as with every migration here; the
-- Worker already running ignores them, so the two need not land together.
ALTER TABLE runs ADD COLUMN accepted_activity_at INTEGER;
ALTER TABLE runs ADD COLUMN legacy_grace_until INTEGER;
