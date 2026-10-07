-- Move the staff roster out of the deployment's configuration and into a table
-- an owner can edit from the admin console.
--
-- Until now the roster was PLATFORM_STAFF_LOGINS, one comma-separated string
-- read by auth/roles.ts. Changing who is staff therefore meant editing a
-- Cloudflare secret and redeploying the worker, which is a task only an owner
-- with console access can do. The roster changes every cohort, and the people
-- who need it changed are the ones who cannot change it. The same string also
-- sat, with real student logins in it, in two tracked files
-- (.dev.vars.example and wrangler.jsonc) because that was the only way to
-- document what it should contain.
--
-- Owners deliberately stay in PLATFORM_OWNER_LOGINS and are not in this table.
-- Owners are the root of trust: if owners lived here, anyone who could write
-- this table could make themselves an owner, and a compromised database could
-- grant itself administrative access. Keeping owners in the environment also
-- solves the bootstrap: on a fresh database this table is empty, and an owner
-- is still staff (auth/roles.ts unions the two), so there is always somebody
-- who can add the first row. Without that, an empty table would lock every
-- user out of the only endpoint that can populate it.
--
-- Keyed on the login string, not on users.id, and that is the deliberate
-- trade. A users.id key would give referential integrity, but it would force
-- every person to sign in before an owner could name them, which is the
-- existing friction in POST /admin/teams/:teamId/tas ("User must sign in
-- before being assigned as a TA"). The roster's job is to name the teaching
-- staff at the start of a cohort, before any of them have an account, so it
-- has to be able to hold a login with no user row behind it. The cost is that
-- the string is unvalidated: a typo is accepted and silently grants nothing.
-- The admin console addresses that by showing, per row, whether an account
-- with that login has signed in yet.
--
-- Two login columns. `login` is lowercased and is the only thing compared,
-- because GitHub logins are case-insensitive and the env list it replaces was
-- matched case-insensitively too. `display_login` keeps the casing the owner
-- typed so the roster reads back the way it was entered; an owner who types
-- "SamGu-NRX" and sees "samgu-nrx" has no way to tell whether it worked. The
-- two cannot drift: display_login is written once and login is its lowercase.
--
-- granted_by holds the granting owner's login as a plain string rather than a
-- foreign key to users. A foreign key would cascade, and an audit trail that
-- disappears when the granting account does is not an audit trail.
--
-- No secondary index. The only read is "is this login staff", an equality on
-- the primary key, and SQLite already indexes that.
CREATE TABLE platform_staff (
  login TEXT PRIMARY KEY,
  display_login TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL
);
