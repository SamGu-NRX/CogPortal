# Public-entry baseline — branch `obv/products-l2-cogportal-public-entry-20261010`

Recorded 2026-10-10, at base `e546392` (`origin/obv/products-cogportal-hardening-20261009`).
Every number below is the output of a command run this session in
`/home/user/work/CogPortal`; nothing is carried over from another session.

## Environment repairs done before the baseline (documented, not committed)

1. **Dependencies were not installed by pnpm.** The pre-existing `node_modules`
   was laid out by bun (`node_modules/.bun/tsx@…`) and owned by root, so
   `tsc -b` failed with `TS5033 … mkdir …/.tmp: permission denied`, and every
   happy-dom test failed with `Cannot find package 'happy-dom'`. Reinstalled
   from the frozen lockfile (`pnpm install --frozen-lockfile`, 6s) after taking
   ownership (`sudo chown -R user:user` on the four `node_modules` trees).
   The lockfile was not modified.
2. **The sandbox's default Node is v20.20.2; the repo requires Node 24+**
   (README "Local development"). Node v24.11.0 was downloaded from
   nodejs.org into `~/opt` and used for all runs below. On Node 20 the
   suite's 43 failing files all crash on the same line:
   `Error: No such built-in module: node:sqlite`. That is an environment
   fact, not a code regression.
3. **Pre-existing uncommitted work stashed before branching** (recoverable,
   not destroyed): a `package.json` diff adding a `workspaces` field, plus an
   untracked `bun.lock` — both consistent with the bun install in (1). Stash
   message: `obv public-entry thread: pre-branch stash of unrelated
   workspaces/bun.lock changes (not ours, preserved)`. The
   `examples/week1-audio-submission/**` files were not touched, read-modified,
   or committed.

## `pnpm check`

```
packages/env check: Done
packages/contracts check: Done
packages/discord-kit check: Done
apps/discord-bot check: Done
apps/portal check: Done
```

All five workspace projects typecheck on Node 24.11.0.

## `pnpm --filter @cogworks/portal test`

| Node | tests | pass | fail | skipped |
|---|---|---|---|---|
| v20.20.2 (sandbox default) | 613 | 570 | 43 | 0 |
| v24.11.0 (repo requirement) | 1254 | 1254 | 0 | 0 |

Node 24 run: `# tests 1254 / # pass 1254 / # fail 0 / # skipped 0`,
duration ≈ 47s. The Node 20 row is kept only to document why: all 43 failing
files die at import on `node:sqlite` (see repair note 2), so their tests never
register — the counts are not comparable between rows.

## Entry-page findings (each supported by code read this session)

1. **The signed-out call-to-action can promise a sign-in the deployment does
   not offer.** `Landing.tsx:56-59` renders "Sign in with GitHub" whenever the
   visitor is signed out, without consulting `session.auth.githubConfigured`.
   The sign-in page itself treats an unconfigured GitHub App as a real state:
   it renders the button disabled with "GitHub sign-in isn't configured. Ask
   course staff to enable it." (`SignInPage.tsx:174-190`). The entry already
   holds the session query (`Landing.tsx:43`), and an anonymous `/session`
   response carries the full auth config — `worker/routes/session.ts:26-29`
   builds it through `authToSession`'s null branch, and
   `worker/auth/session.ts:99-102` returns `auth: authConfig(env)` with
   `githubConfigured` in it (`:88-97`). So the entry can label its CTA
   truthfully without any new endpoint or behavioral edit elsewhere.
2. **The numbered sequence skips the two portal steps the CTA lands on.**
   The "How a capstone week goes" list runs "Bring a repository" → "Set up
   your machine" (`Landing.tsx:97-146`), but the portal's own onboarding
   ladder is Sign in → Cohort → Team → Set up (`OnboardingPath.tsx:14-19`),
   and `nextStagePath` (`App.tsx:36-42`) sends a fresh sign-in to `/join`
   first, then `/connect`. A student who clicks the entry's primary button
   immediately meets steps the list never names.
3. **The fork-template link already works signed out** — keep it.
   `Landing.tsx:91-113` renders the template link from
   `session.auth.templateRepo`, and that field rides the anonymous session
   (`worker/auth/session.ts:94`, `GITHUB_TEMPLATE_REPO ?? null`).
4. **The quota sentence traces to the contracts, and the CLI sentence traces
   to the installed CLI.** `PRACTICE_LIMIT = 10` and `OFFICIAL_LIMIT = 3` at
   `packages/contracts/src/schema.ts:1683-1684`; the `cogworks` console script
   is `cogbench.cli:main` (`python/cogbench/pyproject.toml:21`), whose `run`
   subcommand is "run the public local practice benchmark"
   (`python/cogbench/src/cogbench/cli.py:82`); the distribution pip installs
   is `cogworks-benchmark` (`python/cogbench/pyproject.toml:6`).
5. **`/setup` is team-gated** (`App.tsx:144-149`, `RequireStage stage="team"`),
   so the entry's step 2 sentence ("The setup page has the exact commands for
   your track", `Landing.tsx:118-122`) is accurate as prose and must not
   become a link: signed out, `/setup` saves a pending return, sends the
   visitor to `/signin`, and a mid-onboarding student is then re-routed to
   the step they owe (`App.tsx:60-90`). The commands themselves are real:
   `setupCommandsForTeam` emits clone / tool / benchmark / link / check lines
   (`setup-progress.ts:111-171`), and the README's student path names the
   same install surface; where wording differs (README's bare
   `cogworks check` vs the rail's
   `cogworks check --benchmark <id> --update-setup`, `setup-progress.ts:171`),
   code wins and the ledger records it.

## Fixture freeze

`apps/portal/test/fixtures/entry-states.ts` — five sessions parsed against the
shipped `SessionSchema` at load (`signedOut`, `signedOutGitHubUnconfigured`,
`pendingJoin`, `pendingConnect`, `ready`) plus one synthetic track parsed
against `BenchmarkSchema`. All values synthetic (`cogworks-fixtures/*`,
`entry-fixture-*`); no per-person data, no live-session values.
