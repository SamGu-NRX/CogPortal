# Cog*Portal real journeys

Playwright journeys that drive the portal the way a student, a TA or a visitor
does: the SPA and Worker built for production by the repo's own Vite and
Cloudflare plugin, served by `vite preview`, over a local D1 with every
migration and `apps/portal/scripts/seed-local.sql` applied. GitHub, Discord and
the Modal runner are local HTTP doubles; nothing else is replaced. The plan
this suite scores is `docs/plan/real-user-readiness.md` (surfaces S1 to S10).

## Running

Node 24, from the repo root after `pnpm install`:

```sh
git submodule update --init benchmarks/week1
tools/portal-real-journeys/stack/setup-python.sh   # Python 3.8 env, first time only
cd tools/portal-real-journeys
npm ci
npx playwright install chromium   # first time only
npx playwright test               # boots the stack, runs every journey, stops it
```

Playwright starts `stack/stack.mjs` itself (its `webServer`). Don't start the
supervisor by hand while a run is going; it needs ports 4173, 8810, 8811-8814
and 8821-8824. Logs land in `test-results/stack-logs/`, traces and videos of
failed journeys in `test-results/artifacts/`, screenshots the journeys take on
purpose in `test-results/evidence/`.

The CLI journeys run the real `cogworks` CLI on Python 3.8, the course's
version, in the environment `stack/setup-python.sh` builds in `.py38/` (this
checkout's CLI and the Week 1 benchmark, editable, and the Week 1 reference
submission's numpy, scipy and matplotlib); `RJ_PYTHON` points elsewhere. A
missing or wrong environment fails those journeys rather than skipping them.
Each CLI process gets its own temporary HOME and config, so it never touches
`~/.cogbench`. Week 1 is the week they score on because its public corpus is
generated locally, so a run needs no download.

## What a run can and can't touch

Each run works in its own temporary directory (`RJ_RUN_DIR` to choose one; it is
kept then). The supervisor writes a wrangler config there from an allowlist of
the checkout's settings, builds into it, and keeps D1, R2 and Durable Object
state there. It never reads or writes `apps/portal/.dev.vars`,
`apps/portal/.wrangler` or `apps/portal/dist`.

Before every Worker boot, the supervisor asks wrangler which vars the Worker
will get and refuses to start unless `GITHUB_API_BASE_URL`,
`DISCORD_API_BASE_URL` and `MODAL_RUNNER_URL` are set to loopback, every
origin is loopback, and no value matches a GitHub client, Discord application,
guild or runner URL from the deployed config (`stack/seal.mjs`;
`apps/portal/test/real-journeys-seal.test.ts` runs in CI). Once the Worker is
up, it checks `/api/session` reports the expected execution provider. Child
processes get an allowlisted environment, so a `CLOUDFLARE_ENV` or provider URL
in your shell can't reach them.

Profiles: `fixture` (development, dev sign-in, fixture execution),
`fixture-restricted` (the same with `STAFF_VISIBILITY=restricted`) and
`production-refusal` (configured like a deployment with fake credentials;
used to prove dev sign-in is refused).

## Doubles and hops

The Worker's provider base URLs point at hops, small forwarding proxies, and
each hop forwards to its double:

| Provider | Hop | Double | What the double does |
|----------|-----|--------|----------------------|
| GitHub REST | 8821 | 8811 | answers 401; only a GitHub-configured Worker calls it |
| Discord | 8823 | 8813 | Activity OAuth with single-use codes, `/v10/users/@me`, bot routes |
| Modal runner | 8824 | 8814 | refuses every job; under the fixture provider nothing should arrive |

Every double journals what it receives (`GET /__doubles/journal`) and labels
its answers with `x-cogportal-double`. A hop rule
(`POST /__hop/rules {match: {method, path}, duplicate, delayMs, times}`)
shapes the wire between the Worker and a provider. The browser-side proxy on
8810 takes the same kind of rule at `POST /__proxy/faults` (`method`, `path`
as a regex, `delayMs`, `drop`, `status`, `body`, `duplicateUpstream`,
`times`).

## Control routes (8810)

- `POST /__control/fresh {profile}`: stop the Worker, rebuild if the profile
  changed, wipe and re-seed D1, start the Worker.
- `POST /__control/restart-worker`: stop and start the Worker, keeping D1.
- `POST /__control/sql {sql}`: rows of the last statement, read from the run's
  D1, for assertions and for setup a journey doesn't exercise.

## Journeys

| File | Surface | What it proves |
|------|---------|----------------|
| `s1-signed-out` | S1 | landing and leaderboard render signed out, axe-clean at 1440, 390 and 320 wide; deep links ask for sign-in; unknown routes say so; skip link works |
| `s2-onboarding-and-cli` | S2 | sign in, join with the cohort code, start a team, link the real CLI by device code; a wrong code is refused |
| `s3-cli-report` | S3, S7 | the real CLI scores the Week 1 reference submission on Week 1's public data (Python 3.8, offline), links by device code and syncs; the Worker stores and the Runs page shows the CLI's own report, number for number, untracked while Week 1 is closed and on its track once open; a second sync changes nothing |
| `s3-hosted-run` | S3 | a practice run started from the Runs page reaches a scored result and stays in history; a missing-adapter run shows the neutral failure card |
| `s4-staff-desk` | S4 | a TA's desk and admin view under both staff visibility settings; an owner still reads names |
| `s5-refusals` | S5 (part) | connect refusals and the signed-out session |
| `s6-activity-link` | S6 (part) | a duplicated Discord code exchange and a duplicated link confirmation still make one link |
| `ops-restart-and-production` | all | sessions survive a Worker restart; a production-configured Worker refuses dev sign-in |
