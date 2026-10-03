# TesterArmy pilot

A local trial of TesterArmy's `e2e` runner against a CogPortal dev server. It asks two things. Can one agent step plus deterministic checks cover a student path end to end? What does the replay cache do across runs? The config refuses any `APP_URL` that isn't a loopback origin, so these tests never reach a deployed portal.

## What each test proves

| Test | Model | What passing shows |
| --- | --- | --- |
| `tests/public-results.e2e.ts` | one agent step | A signed-out visitor gets from the landing page to `/leaderboard`, which opens on Vision under "Published results". |
| `tests/cli-link.e2e.ts` | one agent step | The URL and code `cogworks link` prints lead to a working approval. The agent approves; the checks after it prove this run's approval. The CLI exits linked, `~/.cogbench` is 0700 and `config.json` 0600, and exactly one new device exists. `cogworks status` answers with the saved token. The teammate can't see the device, and once it's revoked `status` fails. |
| `tests/cli-link-keyboard.e2e.ts` | none | The same approval in the page's tab order. One Tab from "Device name" reaches "Approve device" and Enter approves. The test prints the focus sequence it saw. |
| `tests/teammate-report.e2e.ts` | one agent step, one reading | A student checks, runs and syncs the Week 3 benchmark from a team repository, once with the reference submission and once after a commit where `embed_text` averages over the wrong axis. The team API gives the teammate both reports, with this run's commit and the benchmark's diagnostic. The agent finds the run on the teammate's page, and that run's row shows the diagnostic. **Red on 3670e55**, see below. |
| `tests/teamless-link.e2e.ts` | one agent step | A cohort member with no team opens the printed link and lands on Connect with a note that the link is on hold, while the code stays open. The agent joins the team. Reopening the printed link then approves the original code: the CLI exits linked and `status` answers. |
| `tests/teamless-offer.e2e.ts` | one agent step in the first test, none in the second | The same start, but after joining, Setup offers the held code as a link to the printed path. Following that link, not reopening the printed one, approves the original code; the CLI links, and the offer and the tab's held link are gone. The used code, held again, is checked and dropped. The second test holds an open code and shows that `/` and `/signin` settle without going to it, that another account signing in on the same tab never sees it, and that it stays forgotten when the first account returns. |
| `support/*.test.ts` | none | The loopback guard; that the CLI helper interrupts and awaits every process it started before removing its HOME, and reports instead of removing when one won't stop; and that inherited `GIT_*` variables can't steer the fixture repository or the CLI to another checkout. |

`teamless-offer.e2e.ts` needs a portal with Setup's offer (branch `fix/pending-device-link-20261003`); against an earlier portal it fails where the offer should appear.

An agent step's own summary is never evidence. Every claim above comes from a deterministic check. The teammate test also prints the agent's reading of where the page explains the low score, as a record only.

The agent in `cli-link.e2e.ts` presses Enter on the approve button directly. That shows keyboard activation, not tab order, which is why the keyboard test exists.

## Open finding: the teammate can't read why a run scored low

`teammate-report.e2e.ts` is tagged `open-finding` and stays red until the product changes. On 3670e55 the benchmark's diagnostic reaches the student's terminal, `cogworks sync` posts it, and `GET /api/v1/local-reports` returns it to the teammate. The Runs page's local-report table then shows only commit, command, result and sync time, so the teammate sees a score of 0.171 with no reason. `npm test` leaves the test out; `npm run test:open-findings` runs it.

## Versions

`e2e` 0.16.0, `@e2e-dev/web` 0.11.2, `ai` 7.0.107, `@ai-sdk/openai` 4.0.71 and `playwright` 1.63.0, whose Chromium build is 1243. The model is `chatgpt('gpt-6-luna')` through a ChatGPT subscription login, at the default reasoning level, with no API key and no fallback. The runner needs Node 22.12 or later; the pilot ran on 26.5.0. The link tests run the student CLI from this repository's `python/cogbench/src` on Python 3.8, the course version.

The teammate test runs the Week 3 benchmark at the commit this repository pins as `benchmarks/week3` (4b17554), on an existing course environment. It is a check of the flow, not of a clean install. The environment used here lacks four packages the graded run installs (`llvmlite`, `noggin`, `numba`, `sklearn`), and `cogworks check` says so.

## One-time login

```sh
E2E_TELEMETRY_DISABLED=1 npx e2e login openai --device
npm run models   # should list gpt-6-luna
```

The framework stores the login in `~/.config/e2e/oauth.json` and refreshes it itself. Nothing here reads or copies that file. If a run fails with `LOGIN_REQUIRED` on a setup that worked before, find out why before signing in again.

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

`--ignore-scripts` also skips Playwright's browser download. The runner needs Chromium build 1243 in the Playwright cache; `npx playwright install chromium` fetches it if it's missing.

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

The teammate test also needs the Week 3 benchmark and its data:

- `PILOT_WEEK3_SRC` is a git checkout of the Week 3 benchmark at the pinned commit with no local changes; `git submodule update --init benchmarks/week3` in the test checkout gives one. The test refuses any other commit.
- `PILOT_LANGUAGE_DATA` is a directory holding the five Week 3 data files: `captions_train2014.json`, `resnet18_features.pkl`, `glove.6B.200d.txt.w2v`, `glove.6B.200d.kv` and `glove.6B.200d.kv.vectors.npy`. Links to an existing cache are fine; the benchmark writes only its own `cache-state.json` beside them. The CLI runs with a fresh HOME, so without this directory the benchmark would download about 935 MB.

## Run

From `tools/testerarmy`:

```sh
npm run typecheck && npm run test:unit

APP_URL=http://127.0.0.1:5195 \
PILOT_CLI_PYTHON=/path/to/python3.8 \
PILOT_CLI_SRC="$PWD/../../python/cogbench/src" \
PILOT_CACHE_DIR=.e2e/cache-mine \
npm test -- tests/cli-link.e2e.ts --reporter list,junit,markdown --output .e2e/runs/first
```

`npm test` turns telemetry off and leaves out the open finding; the config fixes one worker and no retries. For the teammate test, add `PILOT_WEEK3_SRC` and `PILOT_LANGUAGE_DATA` and use `npm run test:open-findings`. A new `PILOT_CACHE_DIR` gives a cold run; reusing it gives a warm one. Each run writes `report.json` under its `--output` directory. For every agent step it records the cache mode, model calls, tokens and the actions taken.

`public-results.e2e.ts` has two switches for cache experiments. `PILOT_EXPECT_HEADING=Audio` makes the run fail on purpose. `PILOT_RENAME_LINK="<link text>"` renames that link in the tab before the step. Run a rename against a copy of the cache, because its live run overwrites the recording with the renamed link, which exists only in the test.

Everything under `.e2e/`, including reports, traces and recordings, is gitignored. So are `.dev.vars` and the local database.

`npm run test:unit` includes a regression that runs real Python against a stand-in for the CLI's isolated worker. It uses `python3` from `PATH`, or `PILOT_CLI_PYTHON_REAL` if set, and skips with a message when neither runs.

## What the tests leave behind, and how they stop

The tests write only to the test checkout's local database: the two synthetic students and their team, the reports the teammate test syncs, setup check-offs, and CLI devices. Each teamless attempt also makes its own accounts (`e2e-pilot-c-*`, `e2e-pilot-d-*`), which join the link team for the attempt and leave it in teardown; the accounts themselves stay. The code the second offer test starts is never approved and runs out after ten minutes. Each link test revokes the device it approved once its checks pass, and the teammate test revokes its device in teardown whatever happened before. A link test that fails partway can leave its device unrevoked. Nothing is deleted record by record; to start clean, discard the test checkout's `apps/portal/.wrangler` (the local database) and run the migrate and seed step again.

When a test ends, the CLI helper sends each `cogworks` process SIGINT, the signal that lets `cogworks run` kill its benchmark worker and remove its scratch directory, and waits up to ten seconds. A process that ignores it is killed so the test can end, but its HOME stays in place and the test fails, saying a worker may still be running. That case needs looking at by hand.

Fixture Git and the spawned CLI drop every inherited `GIT_*` variable, and fixture Git ignores global and system config, so a shell inside a git hook can't point the fixture's commits at another checkout.

## Measured on 3 October 2026 at 3670e55

| Step | Cold | Warm |
| --- | --- | --- |
| Landing to results | 2 model calls, 9,231 tokens, 5.1 s | replayed, 0 calls, 0.4 s |
| Link approval | 6 model calls, 28,400 tokens, 22.8 s | replayed 5 of 5 actions, 0 calls, 15.0 s |
| Teammate finds the synced run | 2 model calls, 8.3 s, plus 1 call for the reading | replayed 1 of 1 action, 0 calls, 0.9 s, plus 1 call for the reading |

The teammate test's CLI part takes about 45 s per attempt: `check` 2 s, the reference run 20 s at a 0.96 GB peak, the broken run 6 s at 1.13 GB, each sync under a second. Every attempt makes new commits, so the cold and warm runs assert on different reports.

The warm approval is slow because each look at `/connections` after a key press took about 2.1 s to settle. The cause isn't known.

## Limits seen in e2e 0.16.0

These are observations of the installed version, not documented guarantees.

- The replay's starting-screen check compares the path and drops the query and fragment (`node_modules/e2e/dist/cache/route.js`). A replay is never evidence that a particular URL or code was handled; assert that directly.
- A replayed step's summary repeats the recorded run's verdict, per-run data included. The warm approval's summary named the cold run's device code.
- Redundant agent actions become part of the recording. The approval recording replays four Tab presses that did nothing.
- A changed control costs a fixed 15 s wait, then a live step from the start. The passing live run then overwrites the recording with what it saw.
- A failed attempt kept a recording that an earlier check in the same attempt had verified.
- `report.json` sets `vcs.dirty` without looking at untracked files, so its commit doesn't pin a test that isn't committed.

## Not covered yet

- Any deployed portal, and Modal, GitHub or Discord.
