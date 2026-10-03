# TesterArmy browser tests

Browser tests of the student path, run locally with TesterArmy's `e2e` runner against this checkout's own dev server. Each test takes at most one agent action step (`agent.act`), and the report test also takes one `agent.extract` reading, which is a model step of its own. Every claim a test makes comes from a deterministic check.

The config refuses any `APP_URL` that isn't a loopback origin, so the browser, the dev logins and the CLI target a local server, never a deployed portal. That guards the test target; it isn't a network sandbox. The model steps call OpenAI, and nothing here stops the local app or the CLI from reaching other hosts.

This directory is outside the pnpm workspace (`pnpm-workspace.yaml` lists `apps/portal`, `apps/discord-bot` and `packages/*`), has its own `package-lock.json`, and isn't run by CI. Nothing here changes the product build.

There are two sets. `npm test` runs the smoke set, which needs only this checkout, a local server and a Python for the CLI. `npm run test:week3-report` runs the Week 3 report journey, which also needs the Week 3 benchmark, its cached data and a course Python environment.

## What each test proves

| Test | Set | Model | What passing shows |
| --- | --- | --- | --- |
| `tests/public-results.e2e.ts` | smoke | one agent step | A signed-out visitor gets from the landing page to `/leaderboard`, which opens on Vision under "Published results". |
| `tests/cli-link.e2e.ts` | smoke | one agent step | The URL and code `cogworks link` prints lead to a working approval. The agent approves; the checks after it prove this run's approval. The CLI exits linked, `~/.cogbench` is 0700 and `config.json` 0600, and exactly one new device exists. `cogworks status` answers with the saved token. The teammate can't see the device, and once it's revoked `status` fails. |
| `tests/cli-link-keyboard.e2e.ts` | smoke | none | The same approval in the page's tab order. One Tab from "Device name" reaches "Approve device" and Enter approves. The test prints the focus sequence it saw. |
| `tests/teamless-link.e2e.ts` | smoke | one agent step | A cohort member with no team opens the printed link and lands on Connect with a note that the link is on hold, while the code stays open. The agent joins the team. Reopening the printed link then approves the original code: the CLI exits linked and `status` answers. |
| `tests/teamless-offer.e2e.ts` | smoke | one agent step in the first test, none in the second | The same start, but after joining, Setup offers the held code as a link to the printed path. Following that link, not reopening the printed one, approves the original code; the CLI links, and the offer and the tab's held link are gone. The used code, held again, is checked and dropped. The second test holds an open code and shows that `/` and `/signin` settle without going to it, that another account signing in on the same tab never sees it, and that it stays forgotten when the first account returns. |
| `tests/teammate-report.e2e.ts` | week3-report | one agent step, one reading | A student checks, runs and syncs the Week 3 benchmark from a team repository, once with the reference submission and once after a commit where `embed_text` averages over the wrong axis. The team API gives the teammate both reports, with this run's commit and the benchmark's diagnostic. The agent finds the run on the teammate's page; that run's row shows the diagnostic, and its first three notes are visible and not covered where they render. |
| `support/*.test.ts` | `npm run test:unit` | none | The loopback guard; that the CLI runs from this checkout's source unless told otherwise, and refuses a source that isn't a regular `cogbench` package with the CLI; that relative CLI, Week 3 and data paths reach the CLI as absolute paths, and Week 3 inputs at another commit, with local changes or missing a data file are refused; that the CLI helper interrupts and awaits every process it started before removing its HOME, and reports instead of removing when one won't stop; and that inherited `GIT_*` variables can't steer the fixture repository or the CLI to another checkout. |

An agent step's own summary is never evidence. The teammate test also prints the agent's reading of where the page explains the low score, as a record only.

`cli-link.e2e.ts` asserts the approval, not how the agent made it; the agent may click or press keys. `cli-link-keyboard.e2e.ts` is the keyboard check. Before the PR91 review, the agent step asked for keyboard-only approval, and the runs measured below at 3670e55 and 6b32aa8 used that instruction; at 3670e55 the agent pressed Enter on the approve button directly.

`teammate-report.e2e.ts` was written red against 3670e55, whose local-report rows dropped the benchmark's diagnostic so the teammate saw a score of 0.171 with no reason. The rows show it since `fix/local-report-notes-20261003` (PR89), which this branch includes.

## Versions

`e2e` 0.16.0, `@e2e-dev/web` 0.11.2, `ai` 7.0.107, `@ai-sdk/openai` 4.0.71 and `playwright` 1.63.0, whose Chromium build is 1243, all pinned in `package.json` and `package-lock.json`. The model is `chatgpt('gpt-6-luna')` through a ChatGPT subscription login, at the default reasoning level, with no API key and no fallback.

Every run recorded here used Node 26.5.0. The repository's CI uses Node 24, which is the safer choice for the portal. `e2e` declares Node 22.12 or later, but the helper tests rely on Node running TypeScript directly, and nothing here was run on 22.12.

The CLI runs from this checkout's `python/cogbench/src`. Every run here used the course's Python 3.8 (3.8.20, a conda environment). `cogbench.cli` also imports on a plain Python 3.9 with no packages installed, but the smoke set wasn't run that way.

The Week 3 report test runs the benchmark at the commit this repository pins as `benchmarks/week3` (4b17554) on an existing course environment. It checks the flow, not a clean install. The environment used here lacks four packages the graded run installs (`llvmlite`, `noggin`, `numba`, `sklearn`), and `cogworks check` says so.

## One-time login

```sh
cd tools/testerarmy
E2E_TELEMETRY_DISABLED=1 npx e2e login openai --device
npm run models   # should list gpt-6-luna
```

The framework stores the login in `~/.config/e2e/oauth.json` and refreshes it itself. Nothing here reads or copies that file, and there is no API-key path. If a run fails with `LOGIN_REQUIRED` on a setup that worked before, find out why before signing in again.

## Setup

Use a checkout made for testing, such as a new `git worktree`, not the one you work in. Setup writes `apps/portal/.dev.vars` and a local database, and the tests add synthetic users to that database.

From the repository root of that checkout:

```sh
pnpm install --frozen-lockfile
(cd tools/testerarmy && npm ci --ignore-scripts)

cd apps/portal
# noclobber: the shell refuses to replace a .dev.vars that is already there
(set -o noclobber; sed 's#http://localhost:5173#http://127.0.0.1:5195#g' .dev.vars.example > .dev.vars)
pnpm db:migrate:local && pnpm db:seed:local
pnpm exec vite --port 5195 --strictPort --host 127.0.0.1
```

`--ignore-scripts` also skips Playwright's browser download. The runner needs Chromium build 1243 in the Playwright cache; `npx playwright install chromium` in `tools/testerarmy` fetches it if it's missing.

The server, `PUBLIC_ORIGIN` and the test target all use `127.0.0.1`. That keeps the approval URL the CLI prints on the same host as the browser's session cookie.

The link tests need two synthetic students on one team. With the server running, open a second terminal at the repository root, sign each student in once, then apply the fixture:

```sh
for login in e2e-pilot-a e2e-pilot-b; do
  curl -s -o /dev/null -w "$login %{http_code}\n" -X POST -H 'content-type: application/json' \
    -H 'Origin: http://127.0.0.1:5195' --data "{\"login\":\"$login\"}" http://127.0.0.1:5195/api/dev/login
done
sqlite3 "$(ls apps/portal/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite | grep -v metadata)" \
  < tools/testerarmy/fixtures/link-team.sql   # prints 2
```

## Smoke set

From `tools/testerarmy`:

```sh
npm run typecheck && npm run test:unit

APP_URL=http://127.0.0.1:5195 \
PILOT_CLI_PYTHON=/path/to/python3.8 \
PILOT_CACHE_DIR=.e2e/cache-mine \
npm test -- --reporter list,junit,markdown --output .e2e/runs/smoke
```

`npm test` turns telemetry off and leaves out the `week3-report` tag; the config fixes one worker and no retries. `APP_URL` defaults to `http://127.0.0.1:5195`. `PILOT_CLI_SRC` defaults to this checkout's `python/cogbench/src`. Set it only to run another source tree, which must hold a regular `cogbench` package (`cogbench/__init__.py` and `cogbench/cli.py`); otherwise Python would import an installed copy instead. A relative path is resolved from where you run `npm`, before it is checked. A single file runs with `npm test -- tests/cli-link.e2e.ts`.

`public-results.e2e.ts` has two switches for cache experiments. `PILOT_EXPECT_HEADING=Audio` makes the run fail on purpose. `PILOT_RENAME_LINK="<link text>"` renames that link in the tab before the step. Run a rename against a copy of the cache, because its live run overwrites the recording with the renamed link, which exists only in the test.

`npm run test:unit` includes a regression that runs real Python against a stand-in for the CLI's isolated worker. It uses `python3` from `PATH`, or `PILOT_CLI_PYTHON_REAL` if set, and skips with a message when neither runs.

## Week 3 report journey (optional)

This needs three more things:

- `PILOT_WEEK3_SRC`, a git checkout of the Week 3 benchmark at the pinned commit with no local changes. `git submodule update --init benchmarks/week3` in the test checkout gives one. The test refuses any other commit.
- `PILOT_LANGUAGE_DATA`, a directory holding the five Week 3 data files: `captions_train2014.json`, `resnet18_features.pkl`, `glove.6B.200d.txt.w2v`, `glove.6B.200d.kv` and `glove.6B.200d.kv.vectors.npy`. The benchmark writes its own `cache-state.json` into this directory, so make one of your own that links to an existing cache rather than pointing at the cache itself. The CLI runs with a fresh HOME, so without this directory the benchmark would download about 935 MB.
- `PILOT_CLI_PYTHON` set to a course environment that has the Week 3 benchmark's packages, since the same interpreter runs `cogworks run`.

Relative `PILOT_WEEK3_SRC` and `PILOT_LANGUAGE_DATA` are resolved from where you run `npm` before they're checked, and the CLI gets them as absolute paths.

```sh
mkdir -p .e2e/week3-data
for f in captions_train2014.json resnet18_features.pkl glove.6B.200d.txt.w2v glove.6B.200d.kv glove.6B.200d.kv.vectors.npy; do
  ln -s "/path/to/existing/cache/$f" ".e2e/week3-data/$f"
done

APP_URL=http://127.0.0.1:5195 \
PILOT_CLI_PYTHON=/path/to/course-env/bin/python \
PILOT_WEEK3_SRC="$PWD/../../benchmarks/week3" \
PILOT_LANGUAGE_DATA="$PWD/.e2e/week3-data" \
PILOT_CACHE_DIR=.e2e/cache-mine \
npm run test:week3-report -- --reporter list,junit,markdown --output .e2e/runs/report
```

On macOS an earlier run of the benchmark leaves its cache in `~/Library/Caches/cogworks-language-search/v1`. Measured at 3670e55, the CLI part took about 45 s and peaked near 1.1 GB; the whole test took 23 s in this branch's run below.

## Replay cache

A new `PILOT_CACHE_DIR` gives a cold run, where every agent step calls the model. Reusing it gives a warm one: recorded action steps replay with no model calls, but a step whose controls changed falls back to a live run, and an `agent.extract` reading always calls the model. Each run's `report.json` records, for every agent step, the cache mode, model calls, tokens and the actions taken.

## Before sharing a report

Everything under `.e2e/` (reports, traces, recordings, fixtures, caches) is gitignored, as are `.dev.vars` and the local database. Read a report, log or trace before passing it on. They can hold this machine's network hostname (the CLI prints `Linked <hostname>`), temporary paths, synthetic logins, device codes and approval URLs, and traces keep screenshots of failed attempts. The codes expire in ten minutes and the accounts exist only in the local database, but the hostname doesn't.

## What the tests leave behind, and how they stop

On the server side, the tests write test data only to the test checkout's local database: the two synthetic students and their team, the reports the teammate test syncs, setup check-offs, and CLI devices. Each teamless attempt also makes its own accounts (`e2e-pilot-c-*`, `e2e-pilot-d-*`), which join the link team for the attempt and leave it in teardown; the accounts themselves stay. The code the second offer test starts is never approved and runs out after ten minutes. Each link test revokes the device it approved once its checks pass, and the teammate test revokes its device in teardown whatever happened before. A link test that fails partway can leave its device unrevoked. Nothing is deleted record by record; to start clean, discard the test checkout's `apps/portal/.wrangler` (the local database) and run the migrate and seed step again.

On this machine, each test that runs the CLI also makes a temporary HOME under the system temp directory (`cog-pilot-home-*`), which holds the report test's team repository too. It is removed when the test ends, except in the case below.

When a test ends, the CLI helper sends each `cogworks` process SIGINT, the signal that lets `cogworks run` kill its benchmark worker and remove its scratch directory, and waits up to ten seconds. A process that ignores it is killed so the test can end, but its HOME stays in place and the test fails, saying a worker may still be running. That case needs looking at by hand.

Fixture Git and the spawned CLI drop every inherited `GIT_*` variable, and fixture Git ignores global and system config, so a shell inside a git hook can't point the fixture's commits at another checkout.

## Measured

On 3 October 2026 at 6b32aa8 (this branch, with 3b54a99 merged), from this checkout's own server, on Node 26.5.0 and Python 3.8.20, with `PILOT_CLI_SRC` unset. Both sets used one new cache, so every agent step ran live:

| Set | Result | Wall | Model use |
| --- | --- | --- | --- |
| `npm test` | 6 tests in 5 files passed | 55.4 s | 4 agent steps, 9 model calls (landing 2, link approval 3, each teamless join 2) |
| `npm run test:week3-report` | 1 test passed | 24.1 s | 1 agent step with 2 model calls, plus 1 call for the reading |

On 3 October 2026 at a966ca1, after the PR91 review dropped the keyboard-only instruction, from this checkout's own server: `cli-link.e2e.ts` passed cold on a new cache in 10.1 s, its one agent action step making 2 model calls (the agent tapped "Approve device"), then warm in 6.9 s with that step replayed and no model calls. `cli-link-keyboard.e2e.ts` passed once in 6.8 s with no model step. The other tests weren't rerun for that change.

On 3 October 2026 at 3670e55, before the product fixes this branch includes:

| Step | Cold | Warm |
| --- | --- | --- |
| Landing to results | 2 model calls, 9,231 tokens, 5.1 s | replayed, 0 calls, 0.4 s |
| Link approval (keyboard-only instruction) | 6 model calls, 28,400 tokens, 22.8 s | replayed 5 of 5 actions, 0 calls, 15.0 s |
| Teammate finds the synced run | 2 model calls, 8.3 s, plus 1 call for the reading | replayed 1 of 1 action, 0 calls, 0.9 s, plus 1 call for the reading |

The teammate test's CLI part took about 45 s per attempt: `check` 2 s, the reference run 20 s at a 0.96 GB peak, the broken run 6 s at 1.13 GB, each sync under a second. Every attempt makes new commits, so a cold and a warm run assert on different reports. The warm approval was slow because each look at `/connections` after a key press took about 2.1 s to settle; the cause isn't known.

## Limits seen in e2e 0.16.0

These are observations of the installed version, not documented guarantees.

- The replay's starting-screen check compares the path and drops the query and fragment (`node_modules/e2e/dist/cache/route.js`). A replay is never evidence that a particular URL or code was handled; assert that directly.
- A recording is keyed to the app's origin, port included, because the default app identity is the base URL (`node_modules/e2e/dist/config/app.js`). A cache recorded against `127.0.0.1:5196` missed against `127.0.0.1:5197` and ran live.
- A replayed step's summary repeats the recorded run's verdict, per-run data included. The warm approval's summary named the cold run's device code.
- Redundant agent actions become part of the recording. The 3670e55 approval recording, made under the keyboard-only instruction, replays four Tab presses that did nothing.
- A changed control costs a fixed 15 s wait, then a live step from the start. The passing live run then overwrites the recording with what it saw.
- A failed attempt kept a recording that an earlier check in the same attempt had verified.
- `report.json` sets `vcs.dirty` without looking at untracked files, so its commit doesn't pin a test that isn't committed.

## Not covered yet

- Any deployed portal, and Modal, GitHub or Discord.
