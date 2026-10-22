-- When an approval of this device code was refused because the signed-in
-- account had no team. The refusal leaves the code open, and the CLI's poll
-- reads this column to tell the student to join a team and reopen the link
-- instead of waiting in silence until the code expires.
--
-- NULL means no such refusal. No backfill: an open code lives ten minutes.
-- Apply before deploying the Worker that reads it.
-- Numbered 0051 because gpt-burst/1022w2-cp-setup already uses 0050.
ALTER TABLE device_authorizations ADD COLUMN team_required_at INTEGER;
