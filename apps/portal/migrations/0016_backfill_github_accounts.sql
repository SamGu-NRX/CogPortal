-- Better Auth resolves returning GitHub users through (provider_id, account_id).
-- Seed immutable GitHub IDs so the first post-cutover login reuses each user's
-- team and cohort instead of creating a second user. OAuth tokens remain NULL;
-- migration 0014 invalidated every session and the next login replaces them.
INSERT INTO accounts (id, account_id, provider_id, user_id, created_at, updated_at)
SELECT
  'acct_' || lower(hex(randomblob(16))),
  CAST(u.github_id AS TEXT),
  'github',
  u.id,
  (cast(unixepoch('subsecond') * 1000 as integer)),
  (cast(unixepoch('subsecond') * 1000 as integer))
FROM users u
WHERE u.github_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.provider_id = 'github'
      AND a.account_id = CAST(u.github_id AS TEXT)
  );
