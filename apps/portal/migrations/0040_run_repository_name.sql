-- Let a finished run keep naming the repository it actually ran from.
--
-- A run already records `repository_id`, the GitHub numeric id of its source,
-- but nothing readable. So the run detail payload and the leaderboard built
-- their repository from the team row instead, and a team that changes its
-- connected repository rewrote the past: every earlier run rendered under the
-- new repository's name, above the old repository's commit (B-06).
--
-- The name goes beside the id, which is how `local_reports` and
-- `local_run_sessions` already record what a local run was against. This is
-- evidence about one run, written once when the run is created and never
-- synchronised with anything afterwards.
ALTER TABLE runs ADD COLUMN repository_full_name TEXT;

-- Fill only the rows whose own recorded id proves which repository they mean.
--
-- This is not relabelling unknown history as the current repository. It fills
-- a name only where the run's `repository_id` still equals the team's
-- `repo_id`, which is the case where the team's current name names the run's
-- repository. An id match proves the same repository, not the same spelling:
-- a repository renamed on GitHub and reconnected since would be filled with
-- its new name, which still resolves, because GitHub redirects the old one.
--
-- A run that predates `repository_id` (migration 0013 added it without a
-- backfill), or one whose id differs from the team's, is left NULL and is
-- reported as unknown rather than guessed.
--
-- Measured on the deployed development database before writing this: 17 runs,
-- 12 with no `repository_id` at all, 5 with one, and all 5 still matching
-- their team. So this names every run there that has a knowable source, and
-- invents nothing for the other 12.
UPDATE runs
   SET repository_full_name = (
     SELECT teams.repo_full_name FROM teams WHERE teams.id = runs.team_id
   )
 WHERE repository_full_name IS NULL
   AND repository_id IS NOT NULL
   AND repository_id = (
     SELECT teams.repo_id FROM teams WHERE teams.id = runs.team_id
   );
