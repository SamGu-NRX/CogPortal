# Platform deployment and operations runbook

No production or course service should be changed by following only part of
this runbook. Keep `EXECUTION_PROVIDER=fixture` until every Modal gate passes.

This repository must be a real Git checkout. GitHub-generated source archives
do not contain `benchmarks/week2`:

```bash
git clone --recurse-submodules <cogportal-repository-url>
git submodule update --init --recursive
python scripts/validate_week2_submodule.py
```

## 1. Verify the repository

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm db:migrate:local
pnpm build
```

CI repeats TypeScript checks, D1 migrations, worker builds, protocol tests, and
Python tests across Python 3.8, 3.11, and 3.13.

## 2. Provision CogPortal

1. Create or select the D1 database and put its real ID in
   `apps/portal/wrangler.jsonc`.
2. Configure the GitHub App callback URLs and read-only Contents/Metadata
   permissions. Set `GITHUB_TEMPLATE_REPO_ID` to the canonical repository's
   immutable numeric ID; the name is only a human-readable fallback in
   development.
3. Configure `PUBLIC_ORIGIN`, `COURSE_GUILD_ID`, and production GitHub secrets.
   Add `DISCORD_BOT_TOKEN` with `wrangler secret put` only when live run
   bubbles are ready to test; never place it in `wrangler.jsonc`.
4. Apply migrations remotely only after reviewing the target account:

```sh
pnpm --filter @cogworks/portal exec wrangler d1 migrations apply cogportal-db --remote
pnpm deploy:portal
```

Confirm `/api/v1/benchmarks`, GitHub sign-in, repository connection, a fixture
practice run, promotion/refund behavior, and the Connections page before
continuing.

## 3. Pass the Modal M0 gate

`docs/runbooks/gate-1-modal.md` is the ordered, executable version of this
section: what to run, in what order, what each command proves, and what each
failure means. It also says, for each of the eight M0 behaviours below, which
are already covered by a test and which still need an operator to look. Use it
for the work; this section stays as the provisioning reference.

Start with the offline check, which costs nothing and catches most of what goes
wrong on a first dispatch:

```sh
python apps/runner-modal/tools/preflight_dispatch.py
```

Use Python 3.11 in an isolated operator environment:

```sh
python3.11 -m venv .venv-runner
source .venv-runner/bin/activate
python -m pip install -e apps/runner-modal
modal setup
modal run apps/runner-modal/src/cogworks_runner/m0_probe.py
```

Before enabling Week 2, materialize each official track under the private
`cogworks-hidden-datasets` volume as
`/<track>/<dataset-version>/payload.zip`. Both track directories also contain
`expected.json`; that file is read only by the controller and is never copied to
the sandbox. Clustering's holds the cluster labels. Recognition's holds the
query grouping: which query photos belong to which enrolled person, and which
belong to the stranger before and after that stranger is enrolled. That grouping
used to travel inside `payload.zip`, where a submission could read it and
reconstruct every expected label without opening a single image, so a
recognition bundle built by an older copy of
`tools/materialize_week2_official.py` has no `expected.json` and must be
rebuilt. Build bundles from the upstream manifest tooling, verify that
official identities and rows are disjoint from both public manifests, mount the
volume read-only operationally, and run one network-blocked canary. A missing or
invalid bundle must surface as `E-DATA` and must not consume an attempt.

The `cogworks-week2-cpu-v1` image bakes the pinned VGGFace2 checkpoint and
verifies SHA-256
`281cebca8662831adb987a874bdcb36e73f5b1c6dc5ee5878f305e985625d99b`
before activation. A cache mismatch is `E-MODEL`, never a student failure.

M0 is not complete until operators also verify:

- evaluation cannot reach the public network;
- preparation reaches only GitHub archive and PyPI hosts;
- sandboxes receive no Modal, GitHub, portal, or dataset secret;
- symlink/special-file and oversized archives fail safely;
- CPU, memory, wall-clock, log, and prediction limits terminate cleanly;
- a snapshot can be restored into a fresh network-blocked sandbox;
- duplicate jobs/events do not duplicate metrics or consume quota twice;
- queue/provider/callback failures become infrastructure failures and refund an
  official attempt;
- hidden labels never appear in the sandbox, practice logs, callbacks, or D1.

Create the external resources only after that review:

```sh
modal volume create cogworks-hidden-datasets --version=2
modal secret create cogworks-runner-signing RUNNER_SIGNING_SECRET="$RUNNER_SIGNING_SECRET" RUNNER_SIGNING_KEY_ID=runner-v1
modal deploy -m cogworks_runner.modal_app
```

Upload reviewed hidden JSON through an approved operator path to
`/hidden/<benchmark-id>/<dataset-version>.json`. Never put hidden data in this
repository, a Worker variable, build output, or a student-accessible bucket.

### Week 3 (language-search)

The `week3_image` bakes the three checksum-pinned course artifacts and the
pre-parsed GloVe `.kv` cache at image build (`image_bake.cache_week3_artifacts`),
so evaluation sandboxes need no dataset network access. Deploying the app
builds it; nothing else to provision for practice runs.

Student code runs under a pinned CPython 3.8.20 venv at `/opt/cogworks-py38`
(Modal's own runtime must be 3.10+, the course contract is 3.8). Both prepare
and evaluate exec through that interpreter, the evaluate script hard-asserts
the version, and the first sanitized-log line records it. Limitation: the
3.11 control interpreter still exists in-container, so this guarantees the
normal evaluation path, not what deliberately adversarial code could invoke.

Official data, from a machine with the artifacts cached:

```sh
# private seed; the manifest never enters any repository
python benchmarks/week3/tools/build_public_manifests.py --official /secure/week3-official.json --seed <PRIVATE_SEED>
python apps/runner-modal/tools/materialize_week3_official.py \
  /secure/week3-official.json <volume-mount> --dataset-version language-search-official-v1
```

The bundle is `payload.zip` (gold-free sandbox inputs) plus `gold.json`
(controller-only truth) under
`/hidden/language-search/language-search-official-v1/`. Verify a deploy
end-to-end without Modal first:

```sh
python apps/runner-modal/tools/run_week3_local_parity.py evaluation
```

which executes the real sandbox evaluate script by subprocess, scores with
the real controller path, and writes signed runner events to a local sink.

## 4. Enable the execution queue

1. Create `cogportal-runs` and `cogportal-runs-dlq` in the same Cloudflare
   account as CogPortal.
2. Uncomment the queue producer/consumer block in `apps/portal/wrangler.jsonc`.
3. Set `MODAL_RUNNER_URL` to the deployed HTTPS endpoint and add the same
   high-entropy `RUNNER_SIGNING_SECRET` to CogPortal with Wrangler secrets.
4. Leave `RUNNER_IMAGE_DIGEST` as the placeholder. An earlier version of this
   step said to write a real `<name>@<id>` there, and that was wrong in a way
   worth spelling out: it is one variable recorded on every run, while
   `_sandbox_image` selects one of three images per benchmark, so any real id
   is false for the two tracks it does not describe. The digest selects no
   image, so neither the placeholder nor a real id can fail a dispatch; the
   choice is only about what gets recorded. Build provenance lives in the
   per-image probe receipts (section 6), which bind the immutable id to the
   interpreter, SDK version and source manifest of that specific image.
5. Deploy with `EXECUTION_PROVIDER=modal`, then run one designated non-credit
   canary repository before allowing students to submit.

The one-hour stale threshold must exceed the queue delay plus both sandbox
timeouts. Lower values are rejected below 15 minutes. The scheduled handler
runs every five minutes and refunds stale official attempts idempotently.

## 5. Deploy CogBot

A Discord application has exactly one Interactions Endpoint URL, and both
portal environments name the same application and the same course guild. That
is confirmed against live metadata, not only against this repository. So
`cogbot` serves exactly one portal at a time, and pointing it at production is
a cutover rather than an addition. There is deliberately no second bot Worker:
a second deployment would be a second name for an endpoint Discord cannot call.

1. Record the way back before changing anything. `wrangler versions list --name
   cogbot` prints the deployed versions; put the current version id in the
   release record. Restoring it later is `wrangler rollback <version-id> --name
   cogbot`, which needs no rebuild. The configuration route back is the two
   values named in `apps/discord-bot/wrangler.jsonc`, which carries the
   development pair in a comment for exactly this purpose.
2. Read the Discord application settings in the Developer Portal without
   editing them. The Interactions Endpoint URL, the OAuth redirect list,
   Activities enablement and distribution eligibility, and the root URL mapping
   are invisible to a Worker and to public API metadata, so looking is the only
   way to know them. Do not reset the application.
3. Note what deploying does not do. A Worker deploy moves nothing on Discord's
   side, so this cutover changes which portal the bot talks to and changes
   nothing about which Activity Discord opens.

   As of **2026-09-14**, reported by the Activity owner and not verified while
   writing this: the interactions endpoint is
   `https://cogbot.sgu07966.workers.dev`; Activities are enabled; the registered
   redirect is `https://127.0.0.1`; the root mapping still points at the
   development Activity; and the production Activity host serves an old landing
   page. Treat these as a dated snapshot to re-check, not as current truth.
   Moving the root mapping to `cogactivity.sillion.app` is a separate owner
   action, approved separately. GitHub Confirm access was pending with Sam on
   that date; do not prompt for it a second time.

   The fuller collection lives in the operator's own notes rather than in this
   repository, which is why the facts that matter are restated above instead of
   being referenced.
4. Set `COURSE_GUILD_ID` in both Workers and `PORTAL_ORIGIN` in CogBot. Add
   `DISCORD_PUBLIC_KEY` to CogBot as a secret. Add `DISCORD_BOT_TOKEN` to
   CogPortal as a secret; the interaction Worker itself does not need it.
5. Deploy CogPortal production first so the `PortalRpc` entrypoint exists on
   `cogportal-production`, which is the Worker the bot's service binding names.
   Then:

```sh
pnpm deploy:discord
```

Do not add a `redirect_uri` to the Activity token exchange to make it resemble
the tutorial. The tutorial registers a redirect for the OAuth app while the
embedded SDK's authorize and token exchange omit it on purpose. A real SDK
launch through the retained native verifier is the acceptance for that path,
and an older CLI clipboard result is not evidence for this release.

6. Install the app to the course guild with `applications.commands` plus the
   `bot` scope. Grant only View Channels and Send Messages in mapped team
   channels. In a temporary operator shell, set `DISCORD_APPLICATION_ID`,
   `DISCORD_BOT_TOKEN`, and `COURSE_GUILD_ID`, then run
   `pnpm --filter @cogworks/discord-bot commands:register`. The bot token is
   used for registration and for CogPortal's live message delivery. Keep it in
   a temporary operator environment and the CogPortal Worker secret, never in
   source-controlled variables.
7. Upload `apps/discord-bot/assets/cog-avatar.png` as the application avatar and use the profile
   copy in `apps/discord-bot/README.md`.
8. Verify PING, wrong-guild rejection, `/cog` linking and in-place refresh, private team/local
   views, explicit channel mapping, leaderboard sharing, and self-reported labels. Run one
   `cogworks run --live` and confirm one message is created, edited for all four phases, and ends
   with hosted verification rather than promotion.

## 6. Production release gates

`apps/portal/wrangler.jsonc` describes the intended production configuration.
Checking it in deploys nothing, and two of its values read as if they were
already true: `EXECUTION_PROVIDER` is `modal` and the R2 binding names a bucket
that does not exist yet. These gates are what has to pass before
`pnpm --filter @cogworks/portal run deploy:production` is run, in this order.
That is the whole command; there is no root `deploy:production` script, and
`pnpm deploy:portal` targets staging.

**Migrations.** Apply the reviewed sequence, not one derived at the keyboard.
The evidence for that sequence comes from the migration review; accepting it is
the lead's, and approving the rollout is root's. The production database's
recorded ledger is far behind this migrations directory.

Duplicate numeric prefixes appear only once the portal and hosted branches are
assembled. This branch's `migrations/` holds 43 files with no repeated number;
the combined candidate carries 45, with two files at `0039` and two at `0040`.
Nothing here says that combined tree is accepted.

Two mechanics for when it is assembled, because the duplicates look more
alarming than they are. Wrangler sorts by the integer before the first
underscore and compares whole filenames when two numbers tie
(`compareSegments`, wrangler 4.110.0), so order is deterministic:
`0039_setup_check_source.sql` would run before
`0039_weight_upload_provenance.sql`. And `d1_migrations` records applied
migrations by name, so a repeated number is not ambiguous for tracking either.
The open question is not mechanical ordering; it is whether two migrations
sharing a number were written against different assumed predecessors, which is
a question about their contents.

Until `benchmarks.sandbox_contract` is populated in production, `startRun` in
`worker/services/run-actions.ts` refuses every Modal run with 409 before it
creates a row, which is correct fail-closed behaviour and not a deploy you can
talk past.

**Secrets.** Set on `cogportal-production` with
`wrangler secret put <NAME> --env production`; they do not copy between
environments. Names only, values never in a file or a chat:
`ACTIVITY_SESSION_SECRET`, `BETTER_AUTH_SECRET`, `DISCORD_BOT_TOKEN`,
`DISCORD_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `PLATFORM_OWNER_LOGINS`,
`RUNNER_SIGNING_SECRET`. The last is the one production does not have.

There is one Modal app and one signing secret, so production's
`RUNNER_SIGNING_SECRET` has to be byte-identical to the value staging holds and
to the one inside the Modal secret. That is a consequence worth stating plainly
rather than discovering: possession of that single value is full authority over
both portals in both directions, so an exposure anywhere is an exposure
everywhere, and a rotation is now a drain of both portals rather than one. See
`rotate-signing-secret.md`, whose "skip this if everything is fixture" shortcut
stops applying the moment production dispatches.

### Gate R2

Create both buckets before deploying either environment:

```sh
wrangler r2 bucket create cogportal-artifacts
wrangler r2 bucket create cogportal-artifacts-dev
```

As of the 2026-09-14 read, R2 is not activated on the account: bucket listing
answers Cloudflare code 10042, a request to activate it in the dashboard.
Activation and billing are owner decisions.

**Verify the binding rather than assuming a refusal.** It would be convenient
if Wrangler always refused a deploy naming a bucket that does not exist, and
that has not been tested here, so do not rely on it. After deploying, confirm
`ARTIFACTS` is present in the binding list Wrangler prints, and confirm both
buckets exist with `wrangler r2 bucket list`. The failure being guarded against
is quiet: a Worker with `ARTIFACTS` unbound answers 501 on weight upload and
otherwise looks healthy.

The two environments name different buckets because weights are addressed by
repository and commit, so one shared bucket would collide on exactly the case
that matters.

### Images, and why this is not one command

`tools/deploy.py` builds each sandbox image, publishes it under a stable name,
and then deploys the app. Publishing the name is what makes an image live:
`_sandbox_image` in `modal_app.py` resolves that name on every dispatch. So in
the current tool a newly built image becomes the one every run uses before
anything has asked whether it works, the three names are published one at a
time, and the app deploy follows them. It is a sequence of individually visible
steps, not an atomic rollout, and it should not be described as one.

The intended order is pause, build, probe, publish, deploy, reactivate:

1. Pause admission for the affected benchmarks (see section 7) and let
   dispatched runs settle.
2. Build the images and keep the immutable `im-...` id each build prints.
3. Probe each image by that id, before any name is republished:

```sh
python apps/runner-modal/tools/probe_prepared_environment.py \
    --benchmark audio-identification \
    --image-id im-XXXXXXXXXXXXXXXXXXXXXX \
    --sandbox-contract 1 \
    --receipt build/audio-receipt.json
```

   The probe runs the same pre-student check `_prepare` runs, inside that exact
   image, with no student archive and no evaluation. It refuses a published
   name, takes the catalog's `sandbox_contract` from the command line rather
   than from the image, and builds each manifest by importing the package and
   walking the directory that import resolved to, so a shadowed copy cannot
   pass by sitting at the expected path. It compares the SDK, the runner and
   the selected benchmark package, driver included, against the accepted
   source, then matches every module the compatibility probe imported back to
   one of those manifests by hash.

   **Run it four times, once per served benchmark.** Audio and Language each
   have their own image. `vision-recognition` and `vision-clustering` are both
   served by `cogworks-runner-benchmark`, so that image is probed twice, once
   under each benchmark id, because the catalog row differs between them.

   `--manifest-only` prints the accepted manifests from this checkout and needs
   no image and no credentials.

4. Publish the names and deploy the app.
5. Reactivate admission.

### Pins the first rehearsal keeps

Two identities are easy to confuse and only one of them is in an image. The
image bakes this checkout's `python/cogbench/src`, and that is what the probe
reports as `sdkVersion` and hashes in the `sdk` manifest. The **student** SDK
pin is separate: it is what a team installs on their own machine.

The student SDK pin is now `1b7fc261`, in `COGBENCH_SOURCE`
(`apps/portal/src/lib/benchmark-packages.ts`) and restated in
`apps/portal/test/command-sheet.test.ts` so moving it takes two deliberate
edits. The Audio benchmark stays at `b156644a`, the submodule pointer this
checkout carries; do not repin that as part of a configuration change.

`b8ae7ce2` adds the saved-sync roles fix to `094a6f1a`. Its child `1b7fc261`
removes ten stale generated SDK files that made an untouched export build from
a 0.1.0 tree. The selected pin contains both repairs.

What is proven, from a terminal against the untouched published archive: the
install reports 0.2.0, all 23 modules byte-match the source, saved Audio roles
and weights are retained, and three installed tests pass. That removes the
earlier installation hold for a bounded 3.11.15 synthetic case.

What is not proven: real authenticated sync, scoring, and a fresh 3.8 install.
This is a staged demo candidate accepted on source and offline install evidence
only. A GitHub VCS install and live sync belong to the native rehearsal, and
nothing here has been deployed or installed into an environment.

One related hazard while reading receipts: `git ls-files` lists 18 files under
`build/`, including ten under `python/cogbench/build/lib/cogbench/`, while
`stale_build_trees` in `apps/runner-modal/tools/deploy.py:62-67` sweeps only
`benchmarks/week{1,2,3}/build`. Probe receipts are unaffected, because the
manifests come from importing each package rather than from walking a path.

Keep the receipts, and read them rather than counting them. The probe refuses
to overwrite an existing receipt, so a file at the expected path may describe
an older image. **A receipt is evidence only when the command exited 0 and the
receipt names the exact image id and benchmark you intended.** Presence alone
proves nothing.

`RUNNER_IMAGE_DIGEST` is not this record and is not meant to become one: one
variable is recorded on every run while the runner selects one of three images
per benchmark, so any real id there is false for two tracks.

### Closing intake across the pending migrations

**Status: blocked. Do not run the release on the assumption that a catalog flag
holds intake closed.** Two source facts break the obvious plan, and neither is
fixed by being careful:

- Catalog state does not survive the migrations. The seeds write their rows
  with `INSERT OR REPLACE`, so they overwrite whatever an operator set.
  `0018_week3_language.sql:14-24` writes `language-search` with `active` 1, and
  `0020_week1_audio.sql:35-45` writes `audio-identification` with `active` 0.
  An operator who closes intake by flipping `active = 0` and then applies the
  pending set has silently reopened Language partway through, and separately
  ends with Audio closed whatever they intended.
- A null `sandbox_contract` cannot gate the Worker that is actually deployed.
  The production Worker predates that column and its `EXECUTION_PROVIDER` is
  `fixture`, so it neither reads the contract nor takes the Modal path the
  guard sits on.

Activation is also not a flag to restore generically. `0020_week1_audio.sql`
sets Audio `active = 0` on purpose, because of the ranking warning recorded
there. Development currently reads `audio-identification` as active, which is a
development decision. Turning Audio on in production is an explicit accepted
setting for the rehearsal, named by the owner, not a byproduct of migrating.

The direction the lead has accepted, to be carried out only with root approval
and not during preparation:

1. Close known intake with `active = 0` and let physically dispatched jobs and
   any queued work drain. Development shares the runner, so its intake has to
   be closed and drained too even though its own writes continue.
2. Hold the door shut for the duration of the migration set with something
   stronger than a catalog flag. That is a full production outage and root has
   to accept it as one.
3. Apply the full migration set while it is held.
4. Deploy the accepted product build with intake still closed.
5. Reopen in stages, with a fresh Audio activation as an explicit decision.

Step 2 is the unresolved one, and the obvious version of it does not work.
`worker/index.ts:66-80` exports `RunWorkflow`, `PortalRpc` and `RunSurfaceHub`
alongside a default with `fetch`, `queue` and `scheduled`. A wrapper that
answers 503 from `fetch` and makes `scheduled` a no-op while re-exporting the
original classes is **not** a no-write state: the queue consumer still runs,
`PortalRpc` is still callable over the bot's service binding, and the Durable
Object and Workflow are still reachable and still write. Calling that
"maintenance" would be claiming a closure that is not there, which is worse
than an honest outage.

The entry also cannot simply drop those exports. The Durable Object binding
needs its class present in the deployed script, and the configuration has to
keep the same name, bindings and `migrations` tag list; getting that wrong
risks the Durable Object rather than just the deploy.

**Decision needed from root**, and this is why the configuration PR is prepared
rather than deploy-ready: whether to accept a full production outage, and a
reviewed entry point that demonstrably closes *every* path that writes, not
only HTTP. Portal has cleared source ownership of such an entry and its tests;
the architecture is not approved and nothing is written yet. Rolling back to a
prior compatible version is the alternative to reopening on the old fixture
Worker, which must not be the resting state because it fabricates runs.

### A stale build can redirect a deploy to the wrong configuration

`apps/portal/.wrangler/deploy/config.json` points Wrangler at
`dist/cogportal/wrangler.json`, a file the Cloudflare Vite plugin generates at
build time with one environment already selected and flattened. Wrangler says
so in one line near the top of its output, `Using redirected Wrangler
configuration`, and then uses it instead of `wrangler.jsonc`.

The consequence is worth knowing before it bites: running
`wrangler deploy --env production` by hand against a tree whose last build was a
staging build deploys staging values under the production flag, and the
generated file carries no `env` key for the flag to select. A dry run performed
that way in preparation for this change reported staging origins, the staging
database and no R2 binding, none of which was in the configuration being
reviewed.

Always deploy through `pnpm --filter @cogworks/portal run deploy:production`,
which sets `CLOUDFLARE_ENV`
for the build as well as the deploy so the generated config is the production
one. If you need to inspect the real file, read `wrangler.jsonc`, or rebuild
first; a `dist/` from another environment is not evidence about either.

**Callback direction.** Before the first production dispatch, confirm the
portal can receive a runner event. `preflight_dispatch.py --deployed <origin>`
sends one unsigned POST to the callback route and reads the status, which
separates "route is live and refusing an unsigned event" from "nothing handles
a POST there"; it is unauthenticated and writes nothing, but it is still a live
request to a deployed origin, so run it deliberately. Do not reach for
`verify_dispatch.py` as a check: its passing case includes a 202, and
`submit_job` answers 202 by spawning `execute_job`, so it schedules real work.

## 7. Rollback and incident response

- Runner incident, steady state: close intake with the catalog. Setting a
  benchmark `active = 0`, or its `sandbox_contract = NULL`, makes `startRun` in
  `worker/services/run-actions.ts` refuse a new Modal run with 409 before it
  creates a run row or reserves quota, so the refused request consumes nothing
  and writes nothing. That closes one path; every other writer is unaffected.
  Runs already dispatched carry their provider on their own row, keep posting
  callbacks and settle normally. Do not delete queue messages or attempts
  manually.

  **This is intake closure on a steady deployment, and it is not a closure that
  survives the pending migration set.** See "Closing intake across the pending
  migrations" in section 6 before using it during the release.
- Do **not** switch `EXECUTION_PROVIDER` to `fixture` to stop production
  execution. It does not stop execution, it fabricates it: the fixture advances
  runs from a wall clock and writes simulated metrics into the production
  database, and those rows then have to be told apart from real ones afterwards.
  `fixture` is a development mode, not a kill switch.
- Do **not** unbind `ARTIFACTS` to recover from a storage problem. A sandbox
  fetches weights over a signed URL while a run is in flight, so removing the
  binding underneath active runs converts them into platform failures. Pause
  admission instead.
- Worker rollback, either environment: `wrangler versions list --name <worker>`
  to find the exact version, then `wrangler rollback <version-id> --name
  <worker>`. No rebuild, and the version id is recorded before the cutover.
- Modal rollback: `modal app history cogworks-runner` to find the version, then
  `modal app rollback cogworks-runner <version>`. Known gap: the sandbox images
  are published under mutable names and resolved by name at dispatch, so app
  versioning does not cover them and a rollback does not restore the images a
  previous version ran against. Recovering an exact image needs its immutable
  id, which is what the probe receipts hold.
- Discord incident: deploy or route-disable CogBot. Portal and CogBench local
  operation remain independent. Revoke account links only if identity mapping
  is affected.
- Signing secret exposure: follow `docs/runbooks/rotate-signing-secret.md`, which
  is the ordered procedure with the exact commands for Modal and for each
  Cloudflare environment, the verification step, and what breaks in the window
  between the two systems. In short: pause Modal dispatch, wait for active jobs
  to become terminal or stale, rotate the secret in both systems and increment
  the key ID, redeploy Modal and Portal, then send a canary. The current v1
  boundary intentionally favors one active key over a complex pre-production key
  ring, so the rotation is necessarily a brief outage rather than a swap.
- GitHub credential exposure: rotate the GitHub App secret, invalidate sessions
  if OAuth tokens may be affected, and revalidate connected repositories.
- Hidden dataset exposure: disable official runs, rotate the dataset version,
  invalidate affected official results with instructor approval, and document
  the incident. Never silently replace a dataset under an existing version.

## 8. Release checklist

- [ ] CI and local verification green
- [ ] D1 backup/export taken, the reviewed migration sequence accepted, and
      `benchmarks.sandbox_contract` populated in production
- [ ] intake closure across the migration set resolved and root-accepted; a
      catalog flag alone does not survive `0018`
- [ ] Audio activation in production named as an explicit decision, not
      inherited from a migration
- [ ] both R2 buckets created, the account activated, and `ARTIFACTS` confirmed
      bound in each environment after deploying
- [ ] production secrets set by name on `cogportal-production`, including
      `RUNNER_SIGNING_SECRET`
- [ ] four probe receipts, one per served benchmark, each exited 0 and naming
      the immutable image id it was probed against
- [ ] `cogbot` pre-cutover version id recorded, and the Discord application
      settings read without editing
- [ ] immutable template repository IDs and revisions reviewed
- [ ] Python packages tested from a clean, non-editable install
- [ ] Modal M0 evidence recorded
- [ ] hidden dataset/scorer versions immutable and approved
- [ ] queue retry and dead-letter alarms configured
- [ ] GitHub and Discord least-privilege settings reviewed
- [ ] fixture rollback tested
- [ ] student setup tested on supported machines and weak Wi-Fi
