# About CogPortal's security and stored data

At the September 15 demo, Joel asked how the platform is secured: whether there
is a password, whether it records addresses, what permissions it holds, who can
add repositories, and whether private repositories work. Ronaldo said he has to
vet the GitHub and Discord linking before MIT runs this. This page answers those
questions from the code, names the file behind each answer, and ends with the
things the repository cannot settle.

Two facts shape everything below. The portal never writes to a student's
repository, and the code that runs student submissions runs in a Modal sandbox
that holds none of the platform's credentials.

## Signing in uses GitHub and nothing else

`createAuth` in `apps/portal/worker/auth/better-auth.ts` configures exactly one
social provider, `github`, and configures it only when both `GITHUB_CLIENT_ID`
and `GITHUB_CLIENT_SECRET` are present. There is no password login on a hosted
deployment: `emailAndPassword.enabled` is `devAuthAvailable(env)`, and
`devAuthAvailable` in `apps/portal/worker/env.ts` requires
`ENVIRONMENT=development`, which only a developer's machine sets. A hosted
Worker cannot turn a password login on by changing one variable.

Four more settings in the same call are worth stating plainly, because they are
the answers a reviewer usually wants:

- `account.accountLinking.enabled` is `false`. A GitHub identity cannot be
  attached to an account that signed in some other way.
- `account.encryptOAuthTokens` is `true`. The stored GitHub token is encrypted
  at rest in D1.
- `disabledPaths` contains `/update-user`, so the Better Auth endpoint that
  would let a client rewrite its own user row is off. The portal needs
  `githubLogin` to be writable by the provider mapping, and that is the reason
  the endpoint is closed.
- `autoDetectIpAddress` is `true` and `geolocationTracking` is `false`. The
  portal records the request address on the session row. It does not look up a
  location for it.

`assertAuthConfiguration` refuses to start unless `BETTER_AUTH_URL` is an HTTPS
origin with no path, query, or credentials, and it allows HTTP only for
localhost. OAuth callbacks are built from that configured origin rather than
from the incoming request host, so a request arriving on some other hostname
cannot redirect the flow.

Rate limiting is on whenever a real environment is bound, and it is stored in
D1 (`rateLimit.storage` is `database`, backed by the `rate_limits` table).

The login identity is a GitHub App, `cog-portal-beta`. The code requests no
OAuth scope string. What the token can reach is the App's declared permissions
and the repositories whoever installed it selected.
`apps/portal/.dev.vars.example` records the intended permissions as Contents
read-only and Metadata read-only, with webhooks and Device Flow disabled, and
`docs/runbooks/platform.md` section 2 says the same. Whether the live App is
configured that way is an owner read in GitHub's settings, not something this
repository can prove.

## What the portal stores

Every table is in `apps/portal/worker/db/schema.ts`. Per person:

- `users`: `name`, `email`, `emailVerified`, `image`, `githubLogin`, `githubId`,
  `avatarUrl`, `cohortId`, `cohortJoinedAt`, and the two timestamps.
- `sessions`: the session token, its expiry, `ipAddress`, and `userAgent`.
- `accounts`: the GitHub `accessToken` and `refreshToken` (encrypted, see
  above), their expiries, and whatever `scope` the provider returned.
- `discord_accounts`: the Discord user id, the Discord username, and when the
  link was made. No Discord token is kept.
- `cli_devices`: a device name and `tokenHash`. The paired CLI token itself is
  never stored, only its hash.
- `device_authorizations`: `deviceCodeHash`, the short `userCode` the student
  types, and a device name, all with an expiry.

Per team, `teams` holds the name, description, the connected repository's owner,
name, full name, URL, default branch, numeric id, the Discord channel id if the
team bound one, and a `provenance` column that marks a row as `live` or
`archive`. `team_members`, `team_tas`, and `platform_staff` hold the rosters.
`cohorts` holds a slug, a name, the join code, and whether the cohort is active.

Runs are recorded per team, not per person. `runs` carries the branch, the
commit, the numeric repository id, a bounded log, diagnostics, and the failure
category and phase; measurements live in `run_metrics`.

One table does key a measurement to a person, and it is worth naming rather than
glossing. `local_reports` has a `userId`, because a student who runs the
benchmark on their own machine and syncs the result is telling their team who
ran it. Those rows are labeled self-reported everywhere they appear and are
never eligible for the leaderboard. In Discord the per-author view is ephemeral,
visible only to the team member who asked for it
(`apps/discord-bot/src/commands.ts`). Nothing computes a number for a person
across runs, and the unsolicited channel messages in
`apps/portal/worker/services/team-nudges.ts` are written so that no sentence
names a person or counts anything per person.

`apps/portal/scripts/scrub-dist-secrets.mjs` runs as part of `pnpm build` and
deletes `.dev.vars` and `.env` files from `dist/`, and fails the build on a
handful of secret-shaped strings. It is a backstop against shipping a credential
in the browser bundle, not a substitute for keeping secrets out of the tree.

## What the portal can reach on GitHub

Every GitHub call in the Worker goes through `githubApiRequest` in
`apps/portal/worker/github/client.ts`. That function sets no HTTP method, so
every call is a GET, and there is no POST, PUT, PATCH, or DELETE anywhere under
`apps/portal/worker/github/`. The portal reads. It does not write, and it cannot
open a pull request, push a commit, or change a setting.

The endpoints it reads are:

- `/user/installations` and `/user/installations/{id}/repositories`, to list
  what the student can pick from.
- `/repos/{owner}/{name}` and its `/branches`, for the repository and its
  branches.
- `/repos/{owner}/{name}/commits` and `/commits/{sha}`, for history. The history
  view covers the most recent 40 commits and sets a `truncated` flag past that.
- `/repos/{owner}/{name}/collaborators/{login}/permission`, to decide whether
  the caller may change team settings.
- `/repos/{owner}/{name}/contents/cogportal.toml`, for the team's own
  configuration file.

There is a webhook endpoint at `POST /api/github/webhook` that verifies an
HMAC-SHA256 `X-Hub-Signature-256` header. Neither hosted environment sets
`GITHUB_WEBHOOK_SECRET`, so the route answers 501 today.

Repositories must be public. `POST /team/repository` in
`apps/portal/worker/routes/team.ts` refuses a private repository with 403 and
the message "Repositories must be public to run the benchmark." The sandbox
could not read a private one anyway, for the reason given under hosted execution
below.

Only a team's own admin can connect or change a repository. `requireTeamAdmin`
requires the `admin` role in `team_members`, then re-reads the caller's
permission on that repository from GitHub at the gate. If GitHub no longer says
`admin`, the stored role is rewritten to whatever GitHub says and the request is
refused. A GitHub outage falls back to the stored role, on the argument that
refusing every admin action during an outage is the worse failure. Two teams in
one cohort cannot claim the same repository: a unique index enforces it and the
second team gets a 403 naming the first.

## Who is an administrator

There are three levels, in `apps/portal/worker/auth/roles.ts`.

Platform owners come from `PLATFORM_OWNER_LOGINS`, a comma-separated list of
GitHub logins matched case-insensitively. It is the only role that lives in
configuration, and the comment in `roles.ts` gives the reason: owners manage the
staff roster, so an owner list the application could write would let anyone who
reached that roster make themselves an owner. An unset value means nobody is an
owner, which fails closed. Changing it needs a redeploy.

Course staff live in the `platform_staff` table since migration 0031, and an
owner edits them in the admin console. On a fresh database that table is empty,
which is recoverable because an owner is staff automatically and can add the
first row.

A TA assigned to one team is a `team_tas` row. `requireStaff` admits owners,
rostered staff, and anyone with a team assignment. Scope follows: an owner sees
every team and the cohort join code, while a TA sees only assigned teams and
reads `null` where the join code would be.

## A cohort join code decides which class a student lands in

`POST /api/cohorts/join` in `apps/portal/worker/routes/cohorts.ts` matches an
uppercased code against an active cohort and, on a match, sets the caller's
`cohortId`. It is not a second password. `requireUser` runs first, so the
student is already signed in with GitHub before a code is checked, and a wrong
code returns 403 `cohort_code_invalid` without revealing anything. An owner can
rotate the code from the admin console, which is the lever for a leaked code.

A code decides which cohort a person joins, and cohort boundaries then hold:
`teams` is unique on cohort plus repository, and a student already on a team in
another cohort gets 409 `already_on_team` instead of crossing.

One shipped default needs attention before anyone signs in.
`apps/portal/migrations/0002_seed.sql` inserts an active cohort whose join code
is `VISION26`, six demo teams owned by `cogworks-demo`, and invented runs with
metrics and leaderboard selections. Those rows make local development usable, and
a fresh remote database takes them as well. Until an owner rotates the code, the
one published in this repository admits anyone, and the public leaderboard shows
six teams that do not exist. `docs/how-to/deploy-your-own.md` step 8 is the
removal. This is worth fixing in the seed rather than in a runbook, and nobody
has done that yet.

## How Discord linking works, and what the bot can see

Linking a Discord account is not a Discord OAuth flow. A student runs `/cog` in
the course server, and the portal mints a random 32-byte token, stores only its
hash in `account_link_tokens` with a ten-minute expiry, and hands back a URL
(`apps/portal/worker/services/identity.ts`). Opening that URL while signed in to
the portal writes one row to `discord_accounts`
(`apps/portal/worker/routes/connections.ts`). The bot never learns the portal
session, and the portal never holds a Discord user token.

`cogbot` is an HTTP interactions Worker, not a gateway bot. Its
`apps/discord-bot/src/index.ts` is a plain `fetch` handler, and its
`package.json` depends on no Discord client library, so there is no persistent
gateway connection and no message content intent. It cannot read channel
history: it never calls Discord's messages endpoint. Every inbound request is
verified with an Ed25519 signature against `DISCORD_PUBLIC_KEY` in
`apps/discord-bot/src/verify.ts`, and an unsigned request gets 401. Two commands
exist, `/cog` and `/launch`.

Outbound team messages are posted and edited by the portal Worker, not the bot,
using `DISCORD_BOT_TOKEN`
(`apps/portal/worker/services/discord-messages.ts`). They go to the channel the
team bound and carry the benchmark, the stage, elapsed time, the short commit,
who started the run, and the result or the failure.

The only guild reads are about the bot itself. When a team binds a channel,
`apps/portal/worker/services/discord.ts` reads the channel, the guild's roles,
and the bot's own guild member record, to decide whether the bot can actually
post there. It does not enumerate students or read their roles.

The Discord Activity is a separate, narrower surface. It uses real Discord
OAuth2 with `scope: ["identify"]` and nothing else
(`apps/portal/src/activity-main.tsx`), exchanged server-side in
`apps/portal/worker/routes/activity.ts`. The resulting session is a cookie
signed with `ACTIVITY_SESSION_SECRET` holding a Discord user id and an expiry,
good for one hour, and every request it authorizes is checked against the
caller's own team.

## How a benchmark run executes

Starting a run makes the Worker sign a job and post it to the Modal app
(`dispatchToModal` in `apps/portal/worker/execution/runner.ts`). Both directions
are HMAC-SHA256 over a timestamp and the body, with the key named in an
`X-Cogworks-Key-Id` header, a 300-second clock-skew limit, and a constant-time
comparison. `apps/portal/worker/routes/runner-events.ts` verifies Modal's
callbacks the same way. Replays are handled by sequence rather than by a nonce:
event inserts do nothing on conflict, and an event at or below the run's last
applied sequence returns early.

The sandbox does not clone the repository. The Worker builds a GitHub tarball
URL for one pinned commit, and `apps/runner-modal/src/cogworks_runner/protocol.py`
refuses any archive URL that does not start with
`https://api.github.com/repos/`. The download in `modal_app.py` sends a
User-Agent and no `Authorization` header, and stops at 100 MiB. Two consequences
follow. Only public repositories can run, and the portal's GitHub token never
enters the sandbox.

Student code runs in a Modal sandbox container separate from the controller, and
in two stages with different network posture:

- Prepare has network, restricted to an outbound allowlist of `api.github.com`,
  `codeload.github.com`, `pypi.org`, `files.pythonhosted.org`, and the callback
  host.
- Evaluate runs with `block_network=True`.

No `Sandbox.create` call passes `secrets=`. `RUNNER_SIGNING_SECRET` is bound
only to the controller function, so student code cannot reach the credential
that would let it forge a result. Audio and Language run student code under a
pinned CPython 3.8.20 venv at `/opt/cogworks-py38`, which matches the version
students run locally.

Official evaluation data is not baked into any image. It lives on the
`cogworks-hidden-datasets` Modal volume, mounted read-only at `/hidden`, and
nothing at run time writes there.

What leaves the sandbox is a result, not a repository. The payload is the
metrics, up to 32 diagnostic strings of 600 characters each, an optional sweep,
an optional wiring trace, and `outputDigest`, which is a SHA-256 hash rather
than the predictions themselves. A prepared-environment id and an environment
digest ride along. The one raw-text channel is `sanitizedLog`, bounded to
`maxOutputBytes` (8 KiB by default) and sent only for practice runs; the Worker
drops it again for official runs. Source files and raw datasets do not cross:
Week 1 renders its roughly 240 MB corpus inside the sandbox and scores it there.

The log buffer keeps its head and its tail and drops the middle, with a count of
what was omitted. The reason is recorded in `modal_app.py`: the benchmark writes
its own closing lines after the submission has run, into the same buffer, and a
head-only cap let a chatty submission push them off the end.

## Twenty-four photographs sit in one branch's history

`result/` holds 24 tracked PNG files, in two directories of 12, each 178 by 218
pixels. Those dimensions and that count match the Week 2 CelebA test fixture
recorded in `docs/design/discovery-v2-ground-truth.json`, which describes the
scored case as 12 images of shape (218, 178, 3) from `celeba-public-test-v1`.
They are output from a local Week 2 run that was committed by accident, and
`result/` is not in `.gitignore`.

At this commit, `git ls-tree -r origin/main -- result/` returns nothing, so main
is clean. The files entered in commit 56316f1, "chore: advance week 2 for its
discovery spec", which is an ancestor both of PR #1's branch
(`feat/automatic-discovery`) and of this branch. So this is not one pull
request's problem; it travels with the shared ancestor, and every branch
descending from that commit carries the photographs until they are removed.

A squash merge keeps them out of main's tree and leaves them in the branch's
commits. The repository has `delete_branch_on_merge` set to `false`, confirmed
on 2026-09-18 against the GitHub API, so merging does not delete the branch and
somebody has to delete it. Until then the photographs stay reachable on GitHub.
Whether faces of real people belong in a course repository at all is a question
for whoever owns the CelebA terms, and it is worth settling before MIT hosts a
copy.

Regenerate the two checks above with:

```sh
git ls-files result/ | wc -l
git ls-tree -r origin/main -- result/ | wc -l
```

## What is not verified here

Everything above is read from the code at this commit. These are not, and a
reviewer should treat them as open:

- The live GitHub App's declared permissions and callback list. Reading them is
  an owner action in GitHub's settings. This repository records the intent and
  cannot confirm the configuration.
- The live Discord application's settings: the OAuth redirect list, whether
  Activities are enabled, the root URL mapping, and the interactions endpoint.
  No Worker or public API exposes them, and deploying a Worker moves none of
  them.
- Whether any dependency in the sandbox images has a known vulnerability. No
  scan has been run, and no result is recorded anywhere in the repository.
- Whether Modal's sandbox isolation holds against a deliberate attempt to break
  out. The platform's own threat model is a student writing ordinary broken code
  that takes something down, not an attacker. Container isolation is Modal's
  claim, not one we have tested.
- Whether D1 and R2 are encrypted at rest and where the data is stored
  physically. Those are Cloudflare's properties, and the answer belongs in
  Cloudflare's documentation rather than here.
- Whether student code, once it has the prepare stage's network allowlist, can
  reach something unintended through PyPI. Nothing pins the packages a student's
  repository asks for.
