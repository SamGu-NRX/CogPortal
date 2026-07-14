# Platform deployment and operations runbook

No production or course service should be changed by following only part of
this runbook. Keep `EXECUTION_PROVIDER=fixture` until every Modal gate passes.

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
4. Apply migrations remotely only after reviewing the target account:

```sh
pnpm --filter @cogworks/portal exec wrangler d1 migrations apply cogportal-db --remote
pnpm deploy:portal
```

Confirm `/api/v1/benchmarks`, GitHub sign-in, repository connection, a fixture
practice run, promotion/refund behavior, and the Connections page before
continuing.

## 3. Pass the Modal M0 gate

Use Python 3.11 in an isolated operator environment:

```sh
python3.11 -m venv .venv-runner
source .venv-runner/bin/activate
python -m pip install -e apps/runner-modal
modal setup
modal run apps/runner-modal/src/cogworks_runner/m0_probe.py
```

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

## 4. Enable the execution queue

1. Create `cogportal-runs` and `cogportal-runs-dlq` in the same Cloudflare
   account as CogPortal.
2. Uncomment the queue producer/consumer block in `apps/portal/wrangler.jsonc`.
3. Set `MODAL_RUNNER_URL` to the deployed HTTPS endpoint and add the same
   high-entropy `RUNNER_SIGNING_SECRET` to CogPortal with Wrangler secrets.
4. Set a content-addressed `RUNNER_IMAGE_DIGEST`; do not ship the
   `unpublished` placeholder.
5. Deploy with `EXECUTION_PROVIDER=modal`, then run one designated non-credit
   canary repository before allowing students to submit.

The one-hour stale threshold must exceed the queue delay plus both sandbox
timeouts. Lower values are rejected below 15 minutes. The scheduled handler
runs every five minutes and refunds stale official attempts idempotently.

## 5. Deploy CogBot

1. Create a Discord application and set its Interactions Endpoint URL to the
   deployed bot Worker.
2. Set `COURSE_GUILD_ID` in both Workers. Add `DISCORD_PUBLIC_KEY` to CogBot as a
   secret. CogBot does not need a bot token at runtime.
3. Deploy CogPortal first so the `PortalRpc` service entrypoint exists, then:

```sh
pnpm deploy:discord
```

4. In a temporary operator shell, set `DISCORD_APPLICATION_ID`,
   `DISCORD_BOT_TOKEN`, and `COURSE_GUILD_ID`, then run
   `pnpm --filter @cogworks/discord-bot commands:register`. The bot token is
   needed only for registration and must not be stored in `.dev.vars` or the
   Worker.
5. Verify PING, wrong-guild rejection, `/cog link` confirmation, `/cog status`,
   self-reported labels, unlinking, and the 2.5-second failure response.

## 6. Rollback and incident response

- Runner incident: switch `EXECUTION_PROVIDER` to `fixture` and deploy the
  portal. Do not delete queue messages or attempts manually. Let callbacks and
  the stale reconciler settle, then inspect run events and refund state.
- Discord incident: deploy or route-disable CogBot. Portal and CogBench local
  operation remain independent. Revoke account links only if identity mapping
  is affected.
- Signing secret exposure: pause Modal dispatch, wait for active jobs to become
  terminal or stale, rotate the secret in both systems and increment the key
  ID, redeploy Modal and Portal, then send a canary. The current v1 boundary
  intentionally favors one active key over a complex pre-production key ring.
- GitHub credential exposure: rotate the GitHub App secret, invalidate sessions
  if OAuth tokens may be affected, and revalidate connected repositories.
- Hidden dataset exposure: disable official runs, rotate the dataset version,
  invalidate affected official results with instructor approval, and document
  the incident. Never silently replace a dataset under an existing version.

## 7. Release checklist

- [ ] CI and local verification green
- [ ] D1 backup/export and migrations reviewed
- [ ] immutable template repository IDs and revisions reviewed
- [ ] Python packages tested from a clean, non-editable install
- [ ] Modal M0 evidence recorded
- [ ] hidden dataset/scorer versions immutable and approved
- [ ] queue retry and dead-letter alarms configured
- [ ] GitHub and Discord least-privilege settings reviewed
- [ ] fixture rollback tested
- [ ] student setup tested on supported machines and weak Wi-Fi
