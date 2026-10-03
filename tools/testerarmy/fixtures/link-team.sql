-- Local-only synthetic team for the link tests. Apply with sqlite3 to the
-- portal's local D1 (apps/portal/.wrangler/state/v3/d1/...) after both users
-- have signed in once through /api/dev/login; see README.md. Never remote.
-- The fixture repository is joinable without GitHub in dev, and no seeded
-- team uses it.
UPDATE users SET cohort_id = 'cohort_bwsi26'
WHERE email IN ('e2e-pilot-a@dev.local', 'e2e-pilot-b@dev.local');

INSERT OR IGNORE INTO teams
  (id, cohort_id, name, description, repo_owner, repo_name, repo_full_name, repo_url, default_branch, repo_id, provenance)
VALUES
  ('team_e2e_pilot', 'cohort_bwsi26', 'E2E Pilot Team', NULL, 'cogworks-demo', 'face-finder',
   'cogworks-demo/face-finder', 'https://github.com/cogworks-demo/face-finder', 'main', 1, 'live');

INSERT OR IGNORE INTO team_members (team_id, user_id, role)
SELECT 'team_e2e_pilot', id, 'admin' FROM users WHERE email = 'e2e-pilot-a@dev.local';
INSERT OR IGNORE INTO team_members (team_id, user_id, role)
SELECT 'team_e2e_pilot', id, 'write' FROM users WHERE email = 'e2e-pilot-b@dev.local';

-- Prints 2 when both students are on the team; anything else means a row
-- was ignored (another team holds the fixture repository in this cohort).
SELECT count(*) FROM team_members WHERE team_id = 'team_e2e_pilot';
