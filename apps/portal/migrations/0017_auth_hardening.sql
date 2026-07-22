CREATE UNIQUE INDEX accounts_provider_account_unique
ON accounts (provider_id, account_id);

CREATE TABLE rate_limits (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL,
  last_request INTEGER NOT NULL
);
