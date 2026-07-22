-- Rebuild users so better-auth owns the canonical identity fields while the
-- portal-specific profile and cohort columns remain available to domain code.
-- D1 runs migrations transactionally, so defer foreign-key checks until the
-- replacement table has been renamed back to users.
PRAGMA defer_foreign_keys = ON;

ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN image TEXT;
ALTER TABLE users ADD COLUMN updated_at INTEGER;

UPDATE users
SET
  email = lower(COALESCE(github_login, id)) || '@users.noreply.github.com',
  email_verified = 0,
  image = avatar_url,
  updated_at = created_at;

DROP INDEX IF EXISTS idx_users_github_id;

-- defer_foreign_keys postpones constraint checks, but SQLite still executes
-- ON DELETE CASCADE actions immediately when users is dropped. Preserve the
-- domain rows owned by those cascades and restore them after the rebuild.
CREATE TABLE users_better_auth_team_tas AS SELECT * FROM team_tas;
CREATE TABLE users_better_auth_discord_accounts AS SELECT * FROM discord_accounts;
CREATE TABLE users_better_auth_device_authorizations AS SELECT * FROM device_authorizations;
CREATE TABLE users_better_auth_cli_devices AS SELECT * FROM cli_devices;
CREATE TABLE users_better_auth_local_reports AS SELECT * FROM local_reports;

CREATE TABLE users_better_auth (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  github_login TEXT,
  github_id INTEGER,
  avatar_url TEXT,
  cohort_id TEXT REFERENCES cohorts(id),
  cohort_joined_at INTEGER
);

INSERT INTO users_better_auth (
  id,
  name,
  email,
  email_verified,
  image,
  created_at,
  updated_at,
  github_login,
  github_id,
  avatar_url,
  cohort_id,
  cohort_joined_at
)
SELECT
  id,
  COALESCE(name, github_login, id),
  email,
  email_verified,
  image,
  created_at,
  updated_at,
  github_login,
  github_id,
  avatar_url,
  cohort_id,
  cohort_joined_at
FROM users;

DROP TABLE users;
ALTER TABLE users_better_auth RENAME TO users;
CREATE UNIQUE INDEX idx_users_github_login ON users (github_login);

INSERT OR IGNORE INTO team_tas SELECT * FROM users_better_auth_team_tas;
INSERT OR IGNORE INTO discord_accounts SELECT * FROM users_better_auth_discord_accounts;
INSERT OR IGNORE INTO device_authorizations SELECT * FROM users_better_auth_device_authorizations;
INSERT OR IGNORE INTO cli_devices SELECT * FROM users_better_auth_cli_devices;
INSERT OR IGNORE INTO local_reports SELECT * FROM users_better_auth_local_reports;

DROP TABLE users_better_auth_team_tas;
DROP TABLE users_better_auth_discord_accounts;
DROP TABLE users_better_auth_device_authorizations;
DROP TABLE users_better_auth_cli_devices;
DROP TABLE users_better_auth_local_reports;

-- Existing sessions are intentionally discarded: their legacy shape stores a
-- plaintext OAuth token and cannot represent better-auth sessions.
DROP TABLE IF EXISTS sessions;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  updated_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX sessions_userId_idx ON sessions (user_id);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  updated_at INTEGER NOT NULL
);
CREATE INDEX accounts_userId_idx ON accounts (user_id);

CREATE TABLE verifications (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
);
CREATE INDEX verifications_identifier_idx ON verifications (identifier);

-- All parent rows and cascaded domain rows are present again. Reset SQLite's
-- deferred-violation counter before D1 commits the migration transaction.
PRAGMA defer_foreign_keys = OFF;
