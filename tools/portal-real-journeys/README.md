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
node stack/acceptance.mjs         # three full runs in a row, one receipt each
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

`stack/acceptance.mjs` runs the suite three times in a row with zero
retries and writes a receipt per run to `test-results/receipts/`: the commit
and tree it ran on (it refuses uncommitted changes to tracked files), start
and end times, Playwright's exit code, and every test's status, retries and
duration.

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

Two more doubles stand in for the Discord client around the Activity:

- `stack/discord-client-double.html`, served by the Activity journeys at
  `http://localhost:8810/__rj/discord-client` (a Playwright route, so the page
  never reaches the Worker), frames the Activity with the query parameters
  Discord adds and answers the embedded SDK's postMessage RPC: handshake,
  READY, AUTHORIZE (with a code minted at the Discord double, so the
  Activity's code exchange through the Worker is the real one), AUTHENTICATE,
  SUBSCRIBE and OPEN_EXTERNAL_LINK, which it records instead of opening.
- On the Activity's host (`localhost`), the proxy strips Discord's `/.proxy`
  prefix the way Discord's URL mapping does, and labels the answer
  `x-cogportal-double: discord-proxy`.

Every double journals what it receives (`GET /__doubles/journal`) and labels
its answers with `x-cogportal-double`. A hop rule
(`POST /__hop/rules {match: {method, path}, duplicate, delayMs, times}`)
shapes the wire between the Worker and a provider. The browser-side proxy on
8810 takes the same kind of rule at `POST /__proxy/faults` (`method`, `path`
as a regex, `delayMs`, `drop` for a lost request, `dropResponse` for a lost
answer, `status`, `body`, `duplicateUpstream`, `times`). WebSocket upgrades
(the run console's live stream) pass through the proxy unshaped.

## Control routes (8810)

- `POST /__control/fresh {profile}`: stop the Worker, rebuild if the profile
  changed, wipe and re-seed D1, start the Worker.
- `POST /__control/restart-worker`: stop and start the Worker, keeping D1.
- `POST /__control/sql {sql}`: rows of the last statement, read from the run's
  D1, for assertions and for setup a journey doesn't exercise.

## Journeys

`RJ_MATRIX_OBSERVE=1` makes the two matrix journeys record what they see
(`test-results/evidence/*-matrix-observed.json`) instead of asserting, for
writing the policy after a route changes. `apps/portal/test/route-matrix-coverage.test.ts`
runs in CI and fails when a route or page has no policy row.

| File | Surface | What it proves |
|------|---------|----------------|
| `s1-signed-out` | S1 | landing and leaderboard render signed out, axe-clean at 1440, 390 and 320 wide; deep links ask for sign-in; unknown routes say so; skip link works |
| `s2-onboarding-and-cli` | S2 | sign in, join with the cohort code, start a team, link the real CLI by device code; a wrong code is refused |
| `s3-cli-report` | S3, S7 | the real CLI scores the Week 1 reference submission on Week 1's public data (Python 3.8, offline), links by device code and syncs; the Worker stores and the Runs page shows the CLI's own report, number for number, untracked while Week 1 is closed and on its track once open; a second sync changes nothing |
| `s3-hosted-run` | S3 | a practice run started from the Runs page reaches a scored result and stays in history; a missing-adapter run shows the neutral failure card |
| `s4-staff-desk` | S4 | a TA's desk and admin view under both staff visibility settings; an owner still reads names |
| `s5-route-matrix` | S5 | every route the Worker registers (read from `app.routes`), called by 19 identities: signed out, revoked and expired sessions, a signed-in-only account, a cohort member with no team, team A's admin and member, team B's member, a member who moved from A to B, an assigned and an unassigned TA, the owner, live, revoked and expired CLI devices and one on team B, and linked, teamless and unlinked Activity sessions. Each answer must match `route-policy.mjs` exactly (status, error code, message); each route also has a positive control that must succeed, or a stated reason it can't here |
| `s5-page-matrix` | S5 | every page the router registers (read from `App.tsx`), opened by the 11 portal identities; where each lands and what it shows must match `page-policy.mjs` |
| `s5-refusals` | S5 | connect refusals and the signed-out session |
| `s6-activity-frontend` | S6 | the Activity frontend on its own host: opened outside Discord it says where to open it; inside the Discord client double, the link gate sends the student to the portal and its check opens the team's bench, a linked student with no team meets the team gate, and the live console streams a hosted practice run to its end, promotes it through the Activity's route, and leaves for the portal through Discord's external-link command |
| `s6-activity-link` | S6 | a duplicated Discord code exchange and a duplicated link confirmation still make one link |
| `s3-publish-leaderboard` | S3, S1 | a practice run from the Runs page, promoted there, published from the official run's console; a signed-out visitor finds it on the active version's board with the run's commit and primary metric |
| `m4-pages` | M4, S1-S6 | every S1 to S6 page, opened as the person who would be on it (and the embedded Activity's gate and bench), at 1440x900, 390x844 and 320x640: axe with zero violations once content loads, text contrast measured on pixels where axe can't decide (`a11y.mjs`), no horizontal overflow; under reduced motion nothing still animating |
| `m4-keyboard` | M4 | onboarding (sign in, join, start a team) and a run's life (start, open, promote, the publish question with Escape and Enter) by keyboard alone; focus is never dropped to the page body and returns to the button that asked |
| `adversarial` | S2, S3 | A1: a slow start stays busy and starts one run; a start whose request is lost (every resend dropped) says the portal couldn't be reached and starts nothing; a start whose answer is lost starts exactly one run however often Chromium resends it, and the page says so truthfully; two renames that reach the Worker in reverse order leave the page showing what was stored. A2: a tab left open after leaving the team in another can't start a run. A3: a Runs page loaded before an owner removed the student refuses to start and recovers on reload. A6: reports outside the contract (too many metrics or notes, long notes, non-numbers, bad precision, missing fields, bad commits, non-JSON) are refused in words and store nothing; extreme values render. A7: a 60-unit team name in Arabic, Hebrew, emoji ZWJ sequences, a bidi override and combining marks reads back exactly and passes M4 on the Team and Runs pages at 1440 and 320 |
| `ops-restart-and-production` | all | sessions survive a Worker restart; a production-configured Worker refuses dev sign-in |
