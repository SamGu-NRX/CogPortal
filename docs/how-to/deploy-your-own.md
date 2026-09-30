# How to deploy your own CogPortal

Follow this to stand up a fresh CogPortal in your own Cloudflare and Modal
accounts, ending with two hosted portal environments, a Discord bot, and a
runner that executes student code. It assumes you can administer those accounts
and a GitHub organization.

This is the first-install order. Once an installation runs,
`docs/runbooks/platform.md` owns releases: it has the ordered production gates,
the image publication procedure, and rollback. Read
`docs/explanation/environments.md` first if you want to know why there are two
environments rather than three.

Keep `EXECUTION_PROVIDER=fixture` in both environments until the Modal steps
pass. A portal with fixture execution is fully usable for sign-in, teams, and
setup; it just never dispatches a real run.

## Before you start

You need:

- A Cloudflare account with Workers, D1, and Durable Objects. R2 is optional and
  is only needed if teams will upload trained weights.
- A Modal account and workspace.
- A GitHub organization that can own a GitHub App.
- A Discord server you administer, and a Discord application.
- Node with `pnpm`, and Python 3.11 with `uv` for the Modal tooling.

Two names in this repository are ours, not yours: the Worker names `cogportal`
and `cogbot`, and the `sillion.app` hostnames. Step 5 changes them.

## 1. Get a real checkout

The three benchmarks under `benchmarks/` are git submodules (`.gitmodules`), and
GitHub's generated source archives leave submodules empty, so clone rather than
download:

```sh
git clone --recurse-submodules <your-cogportal-fork-url>
cd CogPortal
git submodule update --init --recursive
```

Then confirm the tree builds before you provision anything:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

`pnpm test` ends with the Python suites (`scripts/run_python_tests.py`), which
refuse to start and name the missing package when the interpreter lacks one.
`.github/workflows/ci.yml` shows the full install, and it is also what
`scripts/validate_week2_submodule.py` needs before it can check the Week 2
submodule.

## 2. Register the GitHub App

Sign-in and every repository read go through one GitHub App.

1. Create a GitHub App in your organization.
2. Grant it Contents (read-only) and Metadata (read-only). Grant nothing else.
   The portal issues only GET requests and never writes to a repository.
3. Leave webhooks, Device Flow, and "Request user authorization during
   installation" disabled. The portal uses an explicit `/api/github/login` flow.
4. Add one callback URL per environment:
   `https://<your-dev-host>/api/auth/callback/github` and
   `https://<your-prod-host>/api/auth/callback/github`. You may instead create a
   separate App for production and give it its own client id and secret.
5. Record the client id, the App slug, and a generated client secret.

If you want to require that every connected repository descends from a course
template, record the template repository's immutable numeric id for
`GITHUB_TEMPLATE_REPO_ID`. Set it only after every team has forked. Setting it
earlier locks out repositories that do not descend from the template.

## 3. Register the Discord application

1. Create a Discord application and add a bot user.
2. Record the application id, the client secret, the bot token, and the public
   key. The public key verifies inbound interaction signatures.
3. Record your server's guild id.
4. Leave the interactions endpoint URL empty for now. You set it in step 11,
   once the bot Worker has a URL.

## 4. Create the Cloudflare resources

Create one D1 database per environment, and note the ids that these print:

```sh
pnpm --filter @cogworks/portal exec wrangler d1 create cogportal-db
pnpm --filter @cogworks/portal exec wrangler d1 create cogportal-db-prod
```

The configuration binds `ARTIFACTS`, where uploaded weights live, in both
environments: dev to `cogportal-artifacts-dev` and production to
`cogportal-artifacts-prod`. Each environment gets its own bucket and never names
the other's, because weights are addressed by repository and commit, and a
shared bucket would let a production run read weights a dev team uploaded.
Create both, and do not attach a public `r2.dev` URL or a custom domain to
either:

```sh
pnpm --filter @cogworks/portal exec wrangler r2 bucket create cogportal-artifacts-dev
pnpm --filter @cogworks/portal exec wrangler r2 bucket create cogportal-artifacts-prod
```

If teams will never upload weights, you can delete an environment's
`r2_buckets` block instead. That environment then answers 501 to a weight
upload, and `apps/portal/test/deploy-config.test.ts`, which asserts both bucket
names, needs the same change.

The Durable Object and its migration are already declared in the configuration,
so the first deploy creates them.

## 5. Put your own names in the configuration

Edit `apps/portal/wrangler.jsonc`. The top-level block is the dev environment
and `env.production` is production. Wrangler keys do not inherit, so change both
blocks:

- `name`, which only the top level has. Production deploys as
  `<name>-production`.
- The `routes` patterns.
- `d1_databases[0].database_id`, from step 4.
- `GITHUB_CLIENT_ID` and `GITHUB_APP_SLUG`, from step 2.
- `PUBLIC_ORIGIN`, `BETTER_AUTH_URL`, and `ACTIVITY_ORIGIN`, to your hostnames.
  `BETTER_AUTH_URL` must be an HTTPS origin with no path.
- `DISCORD_CLIENT_ID` and `COURSE_GUILD_ID`, from step 3.
- `EXECUTION_PROVIDER`, which the file sets to `modal`. Set `fixture` for now;
  step 10 says when to change it back.

Leave `ENVIRONMENT` at `production` and `DEV_AUTH` at `disabled` in both
blocks. `development` is for the local loop, where together with
`DEV_AUTH=enabled` and no GitHub credentials it turns on password sign-in.

Then edit `apps/portal/package.json` so `deploy:production` sets
`VITE_PORTAL_ORIGIN` and `VITE_ACTIVITY_HOSTNAME` to your production hostnames.

`apps/portal/test/deploy-config.test.ts` checks that the two blocks declare the
same variables, that each environment's origins match the hosts it is routed
on, and that each binds its own bucket. Run `pnpm test` after editing, and fix
what it reports before deploying.

## 6. Set the Worker secrets

Secrets do not copy between environments, so set each one twice. Names only;
never put a value in `wrangler.jsonc`.

Generate the two runner signing values first and keep them in the shell: step 9
puts the same bytes into the matching Modal secrets, and a Worker whose value
differs from its runner's gets 401 on every dispatch.

```sh
cd apps/portal
RUNNER_SIGNING_SECRET=$(openssl rand -hex 32)
PROD_RUNNER_SIGNING_SECRET=$(openssl rand -hex 32)
for name in ACTIVITY_SESSION_SECRET BETTER_AUTH_SECRET DISCORD_BOT_TOKEN \
            DISCORD_CLIENT_SECRET GITHUB_CLIENT_SECRET PLATFORM_OWNER_LOGINS; do
  pnpm exec wrangler secret put "$name"
  pnpm exec wrangler secret put "$name" --env production
done
printf %s "$RUNNER_SIGNING_SECRET" | pnpm exec wrangler secret put RUNNER_SIGNING_SECRET
printf %s "$PROD_RUNNER_SIGNING_SECRET" | pnpm exec wrangler secret put RUNNER_SIGNING_SECRET --env production
```

Notes on three of them:

- `BETTER_AUTH_SECRET` must be at least 32 characters.
- `PLATFORM_OWNER_LOGINS` is a comma-separated list of GitHub logins, not a
  credential. It goes in as a secret so it stays out of the checked-in
  configuration. It is the only role that lives in configuration at all, because
  owners manage the staff roster; see `apps/portal/worker/auth/roles.ts`. An
  unset value means nobody is an owner.
- `RUNNER_SIGNING_SECRET` must be byte-identical to the value inside the Modal
  secret for the same environment, which is why step 9 reads the two shell
  variables set above rather than generating its own.

## 7. Apply the migrations

Review which account you are pointed at, then apply:

```sh
pnpm --filter @cogworks/portal exec wrangler d1 migrations apply cogportal-db --remote
pnpm --filter @cogworks/portal exec wrangler d1 migrations apply cogportal-db-prod --remote --env production
```

A fresh database takes the whole directory in order. If you are reconciling a
database that already has rows, do not derive the sequence from filenames;
`docs/runbooks/platform.md` section 6 explains why and who owns that decision.

## 8. Rename the seeded cohort

This step is for the two databases you created in step 4, after step 7 and
before any student signs in.

`apps/portal/migrations/0002_seed.sql` gives every new database one cohort,
`cohort_bwsi26`, with a random join code, plus the benchmark catalog. The admin
console manages that one cohort and cannot create another, so rename it rather
than adding a second. The join code is visible only in the admin console, which
exists once step 10 has deployed the portal, so this step does the database
half and step 10 finishes it. Rename the cohort in both databases:

```sh
cd apps/portal
pnpm exec wrangler d1 execute cogportal-db-prod --remote --env production --command \
  "UPDATE cohorts SET slug = 'your-slug', name = 'Your Cohort Name' WHERE id = 'cohort_bwsi26'"
pnpm exec wrangler d1 execute cogportal-db --remote --command \
  "UPDATE cohorts SET slug = 'your-slug', name = 'Your Cohort Name' WHERE id = 'cohort_bwsi26'"
```

Check both before handing a code out. Each should list one cohort with your
name and zero teams:

```sh
pnpm exec wrangler d1 execute cogportal-db-prod --remote --env production --command \
  "SELECT id, slug, name, active FROM cohorts; SELECT count(*) AS teams FROM teams"
pnpm exec wrangler d1 execute cogportal-db --remote --command \
  "SELECT id, slug, name, active FROM cohorts; SELECT count(*) AS teams FROM teams"
```

The demo cohort code `VISION26`, the six `cogworks-demo` teams and their
invented runs live in `apps/portal/scripts/seed-local.sql`. Only
`pnpm db:seed:local` applies it, always with `--local`, and `pnpm dev` runs it
for you. A database that applied `0002_seed.sql` before the demo rows moved
out still holds them, and its join code is still the published `VISION26`;
wrangler never runs a recorded migration twice, so upgrading changes neither.
Rotate that code in step 10. If the team count above is not zero on a database
nobody uses yet, those are the demo rows. These clear every team and run, so
run each only against a database whose count was not zero and that no course
uses yet:

```sh
pnpm exec wrangler d1 execute cogportal-db-prod --remote --env production --command \
  "DELETE FROM leaderboard_selections; DELETE FROM official_attempts; DELETE FROM run_metrics; DELETE FROM run_phases; DELETE FROM runs; DELETE FROM teams;"
pnpm exec wrangler d1 execute cogportal-db --remote --command \
  "DELETE FROM leaderboard_selections; DELETE FROM official_attempts; DELETE FROM run_metrics; DELETE FROM run_phases; DELETE FROM runs; DELETE FROM teams;"
```

Leave the `benchmarks` rows alone. Later migrations build on the seed's rows:
`0013_week2_vision.sql`, for one, retires the seed's version 1 vision rows and
adds their successors. Read which benchmarks are active with
`SELECT id, version, active FROM benchmarks`; activating one is a separate
decision about whether its hosted image and dataset are ready.

## 9. Stand up the Modal runner

Build a deploy environment first. The Modal tooling needs its own Python 3.11
virtual environment, separate from the course environments:

```sh
uv venv --python 3.11 .venv-deploy
uv pip install --python .venv-deploy/bin/python "modal>=1.0,<2" "fastapi>=0.115,<1"
```

`docs/runbooks/hosted-benchmarks.md` has the remaining installs, including the
benchmark packages the images build from.

Create the shared volume and one signing secret per environment, from the two
values step 6 generated and stored in the Workers:

```sh
modal volume create cogworks-hidden-datasets --version=2
modal secret create cogworks-runner-signing \
  RUNNER_SIGNING_SECRET="$RUNNER_SIGNING_SECRET" RUNNER_SIGNING_KEY_ID=runner-v1
modal secret create cogworks-runner-production-signing \
  RUNNER_SIGNING_SECRET="$PROD_RUNNER_SIGNING_SECRET" RUNNER_SIGNING_KEY_ID=runner-v1
```

The two environments keep the same key id and different secret values. Only one
key is ever active, so a mismatch is a bare 401 on both sides. Before
dispatching anything, run the offline check, which compares the two HMAC
implementations by computing signatures with both:

```sh
python apps/runner-modal/tools/preflight_dispatch.py
```

Now build the three sandbox images without publishing them. Publishing a name is
what makes an image live, so building and publishing are separate commands:

```sh
.venv-deploy/bin/python apps/runner-modal/tools/deploy.py --build-only
```

That prints one immutable `im-...` id per image, for
`cogworks-runner-benchmark`, `cogworks-runner-week3`, and
`cogworks-runner-week1`. Record all three. Probe each id before any name moves,
then publish the names and deploy the dev runner:

```sh
.venv-deploy/bin/python apps/runner-modal/tools/deploy.py \
  --publish cogworks-runner-benchmark=im-XXXXXXXXXXXXXXXXXXXXXX \
  --publish cogworks-runner-week3=im-XXXXXXXXXXXXXXXXXXXXXX \
  --publish cogworks-runner-week1=im-XXXXXXXXXXXXXXXXXXXXXX
```

Deploy production against the same three ids. Production never publishes a name,
so a later dev release cannot move an image underneath it:

```sh
.venv-deploy/bin/python apps/runner-modal/tools/deploy.py --target production \
  --sandbox-image cogworks-runner-benchmark=im-XXXXXXXXXXXXXXXXXXXXXX \
  --sandbox-image cogworks-runner-week3=im-XXXXXXXXXXXXXXXXXXXXXX \
  --sandbox-image cogworks-runner-week1=im-XXXXXXXXXXXXXXXXXXXXXX
```

The command refuses to run unless every sandbox image has an id. There are no
current ids recorded in this repository; each release captures its own from
`--build-only`. The probe procedure and what its receipts do and do not cover
are in `docs/runbooks/platform.md`, "Images, and why this is not one command".

Each deploy prints the endpoint for `submit_job`. Put the dev endpoint in the
top-level `MODAL_RUNNER_URL` and the production one in `env.production`, read
from the deploy output rather than assembled from a pattern.

Official evaluation data is not in this repository and must never enter it.
Upload reviewed bundles to the `cogworks-hidden-datasets` volume. The layout
differs by week (Week 2 and Week 3 each write a `payload.zip` beside
controller-only answers), so use the materializers in
`docs/runbooks/platform.md` section 3 rather than writing files by hand.
Practice runs work without it.

## 10. Deploy the portal

Deploy dev first, then production:

```sh
pnpm deploy:portal
pnpm --filter @cogworks/portal run deploy:production
```

There is no root script for production. Set `EXECUTION_PROVIDER` to `modal` only
after the Modal gates in `docs/runbooks/gate-1-modal.md` pass. Until
`RUNNER_SIGNING_SECRET` is set, dispatch answers 501 rather than failing quietly.

Now finish step 8. In each environment, sign in with a login from
`PLATFORM_OWNER_LOGINS` and open the admin console. If it shows `VISION26`,
the database took the older seed and that code is public, so rotate it before
handing anything out. The code the console shows is the one you hand out;
rotate it there whenever one leaks.

## 11. Deploy the bot and point Discord at it

The bot binds to the portal Worker by name, so deploy the portal first or the
binding does not resolve.

1. In `apps/discord-bot/wrangler.jsonc`, set `name`, the `services[0].service`
   to your production Worker name, `COURSE_GUILD_ID`, and `PORTAL_ORIGIN`. The
   service and the origin must name the same environment. A binding pointed at
   production with a dev origin still answers commands and hands every student a
   link to the wrong portal.
2. Set the one secret:

```sh
pnpm --filter @cogworks/discord-bot exec wrangler secret put DISCORD_PUBLIC_KEY
```

3. Deploy and register the commands. The registration script reads
   `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`, and `COURSE_GUILD_ID` from the
   shell and refuses to run without all three:

```sh
pnpm deploy:discord
export DISCORD_APPLICATION_ID=<application-id> COURSE_GUILD_ID=<guild-id>
read -rs DISCORD_BOT_TOKEN && export DISCORD_BOT_TOKEN
pnpm --filter @cogworks/discord-bot run commands:register
```

4. In the Discord developer portal, set the interactions endpoint URL to the
   deployed bot's URL. Discord verifies it with a signed ping, so the deploy has
   to come first.

## 12. Check it

Walk the real path in a browser, signed in as a student account rather than as
an owner:

1. `GET /api/v1/benchmarks` returns the catalog.
2. Sign in with GitHub.
3. Join the cohort with the code you rotated in step 10.
4. Create a team and connect a public repository you have admin on.
5. Start a practice run and read the result.
6. Run `/cog` in Discord and confirm the link, then bind a team channel.

`docs/runbooks/platform.md` section 8 is the fuller release checklist. If every
request returns 500 with a fetch error during local development, the Worker is
wedged from stale HMR and the dev server needs a restart; that failure does not
appear in a deployed environment.
