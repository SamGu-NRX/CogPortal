-- A student belongs to exactly one team (the repository is the team).
-- The composite PK on (team_id, user_id) only prevented duplicate rows for
-- the same pair — two concurrent joins against DIFFERENT teams could both
-- commit. Enforce the single-team invariant at the database layer; the
-- check-then-insert paths already map unique-constraint failures to
-- `already_on_team`.
--
-- Defensive dedupe first: keep each user's earliest membership by team id
-- ordering (deterministic), drop any strays before the index lands.
DELETE FROM team_members
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM team_members GROUP BY user_id
);

CREATE UNIQUE INDEX team_members_user_unique ON team_members (user_id);
