# About CogPortal's two hosted environments

CogPortal runs in two places, and they are deliberately the same shape.

The decision matters because the alternative is worse in a specific way. If the
environment a change is checked in differs from the one students use, the check
stops being evidence. Two environments built from one configuration file, with
one set of pins and one migrations directory, mean a passing journey on dev is a
real prediction about prod, except where the list below says they differ.

## The two environments

**Dev.** Worker `cogportal`, at `cogportal-dev.sillion.app` and
`cogactivity-dev.sillion.app`. This is the top-level block in
`apps/portal/wrangler.jsonc`, and `wrangler deploy` with no `--env` targets it.
Every change is checked here against real GitHub and real Modal. A run started
on dev dispatches to a real Modal app and spends real sandbox time.

**Prod.** Worker `cogportal-production`, at `cogportal.sillion.app` and
`cogactivity.sillion.app`. This is `env.production` in the same file, deployed
with `pnpm --filter @cogworks/portal run deploy:production`. There is no root
script for it, and the root `pnpm deploy:portal` targets dev.

The Discord bot is one Worker, `cogbot`, with no named environments. Its service
binding names `cogportal-production`, so at any moment the bot talks to exactly
one portal. Pointing it at dev means editing `apps/discord-bot/wrangler.jsonc`
and redeploying, which the comments in that file describe.

## They differ in names, secrets, data and storage, and nothing else

Wrangler keys are not inheritable, so `env.production` re-declares every
variable, route, and binding rather than overriding a few.
`apps/portal/test/deploy-config.test.ts` asserts that production declares the
same set of variables as the top-level block, which is what keeps the two
blocks from drifting when somebody edits one.

What differs:

- The Worker name and the hostnames.
- The D1 database: `cogportal-db` for dev, `cogportal-db-prod` for prod.
- The Modal app and its signing secret: `cogworks-runner` with
  `cogworks-runner-signing` for dev, `cogworks-runner-production` with
  `cogworks-runner-production-signing` for prod. A dev deploy therefore cannot
  move prod's controller or its images.
- R2. An environment that stores trained weights binds `ARTIFACTS` to its own
  private bucket in its own `r2_buckets` block, and neither may name the
  other's. Both do today: dev binds `cogportal-artifacts-dev` and prod binds
  `cogportal-artifacts-prod`, and `deploy-config.test.ts` asserts both names.
  An environment without the block answers 501 to a weight upload, so dev
  predicts prod's weighted runs only while both keep one.
- Every secret value. Wrangler secrets do not copy between environments, so each
  is set once per environment with `wrangler secret put`.

What is the same, on purpose: the migrations directory, the Durable Object class
`RunSurfaceHub`, the five-minute cron, `ENVIRONMENT` and `DEV_AUTH`,
`RUNNER_SIGNING_KEY_ID` (`runner-v1` in both), `RUNNER_PYTHON_VERSION`,
`RUN_STALE_AFTER_SECONDS`, the Discord application and guild, and the three
pinned sandbox image ids once a release has captured them.

Both hosted Workers set `ENVIRONMENT` to `production` and `DEV_AUTH` to
`disabled`, and the schema in `apps/portal/worker/env.ts` accepts only
`development` and `production`. So `ENVIRONMENT` does not tell dev from prod;
the Worker name, the hostnames and the D1 database do. On the dev Worker the
value means "behave like a hosted deployment", not "this is the course". The
only value any code branches on is `development`, which is local: it enables
password sign-in (`devAuthAvailable` in `env.ts`), trusts the Vite origin in
`apps/portal/worker/auth/better-auth.ts`, and turns on response schema checks
in `apps/portal/worker/http/errors.ts` and `http/respond.ts`.
`apps/portal/test/better-auth.test.ts` checks that `production` keeps password
sign-in off even with `DEV_AUTH=enabled`.

## Local `pnpm dev` is the local loop, not a third environment

`pnpm dev` serves on port 5173, and its `predev` step applies D1 migrations to a
local SQLite file under `apps/portal/.wrangler/`. With `apps/portal/.dev.vars`
copied from `.dev.vars.example`, it runs with `EXECUTION_PROVIDER=fixture`,
which advances runs from a wall clock and sends nothing anywhere, and it can
accept `POST /api/dev/login` because `ENVIRONMENT=development`,
`DEV_AUTH=enabled` and empty GitHub credentials together allow it. Fixtures and
a dev login are the point: the local loop costs nothing and needs no
credentials.

That also makes it the wrong place to prove a change works. A fixture run never
touches Modal, so it cannot tell you whether the job you dispatched is one the
runner accepts. Nothing deploys from a laptop's local state.

## How a commit travels

1. Pick the one commit you mean to ship.
2. Deploy that commit to dev.
3. Drive one real journey on dev: sign in, connect a repository, start a hosted
   run, and read the result. `docs/runbooks/platform.md` section 8 is the
   release checklist around it.
4. Deploy the same commit, and the same three sandbox image ids, to prod.

Prod never gets a commit dev has not run. Image ids travel with the commit
rather than being rebuilt for prod, because publishing an image name is what
makes it live, and prod resolves ids directly so that a dev release cannot move
an image underneath it.
`docs/runbooks/platform.md`, "Production runs the same ids without the names",
is the procedure.

Rolling back a Worker is `wrangler rollback <version-id> --name <worker>`, for
`cogportal`, `cogportal-production` or `cogbot`: it restores a recorded version
without rebuilding, which is why the version id is worth capturing before a
cutover. It rolls back the Worker only, not the runner or its images;
`docs/runbooks/platform.md`, section 7, has the runner side. Switching
`EXECUTION_PROVIDER` to `fixture` is not a rollback: fixture mode does not stop
execution, it fabricates it, and it would write simulated metrics into the
production database.

## "Staging" and "dev" name the same Worker

This page says dev. The repository still says staging in places: the comments
in `apps/portal/wrangler.jsonc`, the runbooks under `docs/runbooks/`, the labels
in `apps/portal/test/deploy-config.test.ts`, and the Modal deploy tool, where
`apps/runner-modal/tools/deploy.py --target staging` selects
`deployment.staging()`, whose app is `cogworks-runner`. All of them mean the
top-level Worker `cogportal` and its runner. There is no third environment
behind the word.
