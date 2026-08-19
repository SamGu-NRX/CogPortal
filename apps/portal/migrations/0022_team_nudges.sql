-- One row per nudge we have already sent a team, so a cron that ticks every
-- five minutes says a thing once rather than seventy-two times a day.
--
-- The kind is part of the key on purpose: a team that hears "no end-to-end run
-- yet" on Wednesday should still hear "one person has touched every stage"
-- later. What it must never do is hear the same sentence twice.
CREATE TABLE team_nudges (
  team_id TEXT NOT NULL REFERENCES teams(id),
  kind TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  detail TEXT,
  PRIMARY KEY (team_id, kind)
);

CREATE INDEX team_nudges_sent_at ON team_nudges (sent_at);
