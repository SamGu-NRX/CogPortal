# Claim and link ledger — the public entry (Landing)

Every claim a visitor can read on the entry, and every link it emits, mapped to
the code that backs it. Verified against the working tree at commit time on
branch `obv/products-l2-cogportal-public-entry-20261010` (base
`obv/products-cogportal-hardening-20261009` @ `e546392`). Paths are
repository-relative; `:N` is the line the wording lives on.

## What changed in this pass (Milestone 2)

Two edits to `apps/portal/src/routes/Landing.tsx`, both traceable to code:

1. **The sign-in CTA no longer promises GitHub unconditionally.** The label is
   `Sign in with GitHub` only when `session.auth.githubConfigured` is true —
   the same flag `SignInPage` disables its GitHub button on
   (`apps/portal/src/routes/SignInPage.tsx:157-171`). An anonymous `/session`
   already carries the auth config (`apps/portal/worker/auth/session.ts:90`),
   so the front page can know before promising. Until the read answers, or
   when the answer is no, the button says `Sign in`, which `/signin` can
   always honor.
2. **One sentence under the CTAs names the steps sign-in starts**, in the
   pages' own words (see row 5). It is prose, not links: `/setup` is
   team-gated (`apps/portal/src/App.tsx:144-149`), so a signed-out link there
   would save a return and bounce through `/signin` (`RequireStage`,
   `apps/portal/src/App.tsx:60-90`).

## Review rework: entry-only swap-tolerant type (and what was reverted)

The first review round had set the app's shared webfonts to
`font-display: optional` to stop shift entries; that masked the swap instead
of fixing it and was reverted — `apps/portal/src/fonts.ts`, root
`package.json` and root `pnpm-lock.yaml` are byte-identical to the base
branch again (empty `git diff` against
`origin/obv/products-cogportal-hardening-20261009`, verified at commit
time). The fix is entry-scoped and measured instead
(`apps/portal/src/styles/app.css`, the `Entry-only, swap-tolerant type`
block):

- Metric-matched fallback faces (`@font-face` with `size-adjust` and
  ascent/descent overrides derived from the webfonts' own box ratios, with
  the overrides scale-compensated because Chrome applies `size-adjust` to
  them too). While the entry is mounted, the theme's font variables point
  at stacks naming these faces; every other route is untouched (`:has()` on
  the Landing's `data-entry-page` is false elsewhere).
- The wordmark renders with `text-rendering: geometricPrecision` and its
  header slot reserves 102px, because the local serif's hinted advances
  cannot match the webfont's at the wordmark's size by any `size-adjust`
  value — the derivation and its limits are in the CSS comment.
- The header's flex nav shrinks to its flex share (`min-width: 0`) so its
  position no longer depends on any face's text width.
- The evidence toolchain is entry-local: `evidence/cogportal-entry/` is its
  own non-workspace package (own `package.json` + `package-lock.json`,
  pinned Playwright 1.64.0 and axe 4.13.0; the workspace globs in
  `pnpm-workspace.yaml` — `apps/portal`, `apps/discord-bot`, `packages/*` —
  do not cover it, so the root lockfile stays untouched). Reproduce with:
  `pnpm --filter @cogworks/portal build && cd evidence/cogportal-entry &&
  npm ci && npx playwright install --with-deps chromium &&
  npx playwright test --config playwright.config.ts` (runs from the
  package's own directory; Node 24 required — the dev server needs
  `node:sqlite`).

No entry claim or link changed in the rework; the table below is unchanged.

## Signed-out entry: claims and links

| # | Element (exact wording) | Kind | Backing code | Note |
|---|---|---|---|---|
| 1 | Eyebrow `CogWorks 2026 capstone benchmark` | claim (identity) | `apps/portal/package.json:7` (portal description names the CogWorks capstone benchmark control plane); `apps/portal/src/routes/LeaderboardPage.tsx:475` (`2026 cohort, anonymized`) | Course year comes from the shipped copy, not invented here. |
| 2 | H1 `See how your capstone holds up as the problem gets harder.` | claim (positioning) | The benchmarks are difficulty-scaled families (`benchmarks/*/benchmark.yaml`), ranked by score on harder sets; the leaderboard ranks entries (`apps/portal/src/routes/LeaderboardPage.tsx:51`) | Positioning, no external fact. |
| 3 | CTA `Sign in with GitHub` → `/signin` | link + claim | Route exists: `apps/portal/src/App.tsx:79`. Claim gated on `session.auth.githubConfigured` (`apps/portal/worker/auth/session.ts:90`, guard at `apps/portal/worker/env.ts:80`), honored by `apps/portal/src/routes/SignInPage.tsx:157-171` | New in this pass: label falls back to `Sign in` when unconfigured/unknown. |
| 4 | CTA `See this year's results` → `/leaderboard` | link | Route exists: `apps/portal/src/App.tsx:80`; the leaderboard is the published results page with the 2026 footer (`apps/portal/src/routes/LeaderboardPage.tsx:475`) | |
| 5 | `Signing in is the first of four steps: join the cohort, join or start your team, then set up your machine.` | claim (wayfinding) | Four steps: `apps/portal/src/components/OnboardingPath.tsx:16-21` (Sign in, Cohort, Team, Set up). Step words are the pages' own headings: `Join the cohort` (`apps/portal/src/routes/JoinPage.tsx:49`), `Join or start your team` (`apps/portal/src/routes/ConnectPage.tsx:211`), `Set up your machine` (`apps/portal/src/routes/SetupPage.tsx`). Landing order follows `nextStagePath` (`apps/portal/src/App.tsx:40-48`), which walks sign-in → cohort → team → setup | New in this pass. |
| 6 | Step 1 `Bring a repository` + `One GitHub repository per team. Every hosted run starts from it.` + fork link to `https://github.com/<templateRepo>` | link + claim | One repo per team: the team schema carries exactly one `repo` (`packages/contracts/src/schema.ts`, `TeamSchema`); connecting it is the team step's job (`apps/portal/src/routes/ConnectPage.tsx`). Template comes from the anonymous session (`apps/portal/worker/auth/session.ts:94`) | Link target renders only when the session carries `templateRepo`; the fixture pins the shape. |
| 7 | Step 2 `The setup page has the exact commands for your track.` | claim, deliberately **not** a link | Commands are emitted by `setupCommandLines` (`apps/portal/src/lib/setup-progress.ts:96-188`) and assembled per team+benchmark by `setupCommandsForTeam` (`:189`) | See README note below. |
| 8 | Step 3 `` `cogworks run` `` + `scores your code on the public practice set` | claim | `cogworks` console script (`python/cogbench/pyproject.toml:21-22`); `run` help: `run the public local practice benchmark` (`python/cogbench/src/cogbench/cli.py:82`) | |
| 9 | Step 4 `10 practice runs and 3 official attempts per benchmark, from the commit you pushed. You choose which official result is shown.` | claim | `PRACTICE_LIMIT = 10` / `OFFICIAL_LIMIT = 3` (`packages/contracts/src/schema.ts:1683-1684`); runs carry the commit (`ShaChip`, `apps/portal/src/routes/LeaderboardPage.tsx:592`); choosing the shown result is the `selected` flag (`packages/contracts/src/schema.ts:339`, `Official runs: currently published on the leaderboard`) and the publish flow's one-public-entry rule (`apps/portal/src/routes/RunDetailPage.tsx:809-812`) | |
| 10 | Specimen `What a run shows` / `Example` + knee trace + `an example, not a benchmark: nothing on it was measured` | claim + figure | Trace is the gallery's `A knee` fixture, same three readings (0.90 at 5 songs, 0.85 at 20, 0.21 at 80): `apps/portal/src/routes/GalleryPage.tsx:204-218`. The marked knee follows SweepTrace's marking rule (`apps/portal/src/components/SweepTrace.tsx:66-78`) | Accessible description asserts the same numbers in `apps/portal/test/entry-landing.test.ts`. |

## README versus code (code wins)

The README's student quick path shows `cogworks check --benchmark <id>` as a
plain command and lists `--update-setup` among the later, advanced flags
(`README.md:90`). The shipped setup rail's check command includes
`--update-setup` (`apps/portal/src/lib/setup-progress.ts:171`) — it is what
sends the evidence (`setup-progress.ts:166`, and the CLI returns without it).
The entry quotes neither command verbatim on the front page; the setup page
renders the real generated commands, which is the authoritative source. No
entry copy was taken from the README.

## Guards this entry deliberately does not cross

- No link to `/setup`, `/connect`, `/dashboard`, `/team`, or `/admin` from a
  signed-out state: all are stage-gated (`apps/portal/src/App.tsx:144-149` and
  the `RequireStage` wrapper), so the wayfinding sentence carries that
  information instead (row 5).
- The `Sign in with GitHub` promise only appears when the session read says
  the GitHub App is configured (row 3).
- No numbers anywhere on the entry come from live sessions, real students, or
  real cohorts. The specimen is the gallery fixture, labeled `Example`.

## Tests pinning this ledger

`apps/portal/test/entry-landing.test.ts` — CTA labels per session state
(including the unconfigured-GitHub fallback), no `/setup` link signed out,
wayfinding sentence present signed-out and absent signed-in, every internal
link lands on a real route, and the specimen's aria-label carries the gallery
fixture readings. Fixtures: `apps/portal/test/fixtures/entry-states.ts`
(synthetic, schema-validated).
