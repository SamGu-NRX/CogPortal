# TesterArmy pilot

A local trial of TesterArmy's `e2e` runner against a CogPortal dev server. It asks two things. Can one agent step plus deterministic checks cover a student path end to end? What does the replay cache do across runs? The config refuses any `APP_URL` that isn't a loopback origin, so these tests never reach a deployed portal.

## What each test proves

| Test | Model | What passing shows |
| --- | --- | --- |
| `tests/public-results.e2e.ts` | one agent step | A signed-out visitor gets from the landing page to `/leaderboard`, which opens on Vision under "Published results". |
| `tests/cli-link.e2e.ts` | one agent step | The URL and code `cogworks link` prints lead to a working approval. The agent approves; the checks after it prove this run's approval. The CLI exits linked, `~/.cogbench` is 0700 and `config.json` 0600, and exactly one new device exists. `cogworks status` answers with the saved token. The teammate can't see the device, and once it's revoked `status` fails. |
| `tests/cli-link-keyboard.e2e.ts` | none | The same approval in the page's tab order. One Tab from "Device name" reaches "Approve device" and Enter approves. The test prints the focus sequence it saw. |
| `support/*.test.ts` | none | The loopback guard, and that the CLI helper stops and awaits every process it started before removing that process's HOME. |

An agent step's own summary is never evidence. Every claim above comes from a deterministic check.

The agent in `cli-link.e2e.ts` presses Enter on the approve button directly. That shows keyboard activation, not tab order, which is why the keyboard test exists.

## Versions

`e2e` 0.16.0, `@e2e-dev/web` 0.11.2, `ai` 7.0.107, `@ai-sdk/openai` 4.0.71 and `playwright` 1.63.0, whose Chromium build is 1243. The model is `chatgpt('gpt-6-luna')` through a ChatGPT subscription login, at the default reasoning level, with no API key and no fallback. The runner needs Node 22.12 or later; the pilot ran on 26.5.0. The link tests run the student CLI from this repository's `python/cogbench/src` on Python 3.8, the course version.

## One-time login

```sh
E2E_TELEMETRY_DISABLED=1 npx e2e login openai --device
npm run models   # should list gpt-6-luna
```

The framework stores the login in `~/.config/e2e/oauth.json` and refreshes it itself. Nothing here reads or copies that file. If a run fails with `LOGIN_REQUIRED` on a setup that worked before, find out why before signing in again.

## Setup

From the repository root:

```sh
pnpm install --frozen-lockfile
(cd tools/testerarmy && npm ci)

cd apps/portal
sed 's#http://localhost:5173#http://127.0.0.1:5195#g' .dev.vars.example > .dev.vars
pnpm db:migrate:local && pnpm db:seed:local
pnpm exec vite --port 5195 --strictPort --host 127.0.0.1
```

The server, `PUBLIC_ORIGIN` and the test target all use `127.0.0.1`. That keeps the approval URL the CLI prints on the same host as the browser's session cookie.

The link tests need two synthetic students on one team. Sign each in once, then apply the fixture:

```sh
for login in e2e-pilot-a e2e-pilot-b; do
  curl -s -o /dev/null -w "$login %{http_code}\n" -X POST -H 'content-type: application/json' \
    -H 'Origin: http://127.0.0.1:5195' --data "{\"login\":\"$login\"}" http://127.0.0.1:5195/api/dev/login
done
sqlite3 "$(ls apps/portal/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite | grep -v metadata)" \
  < tools/testerarmy/fixtures/link-team.sql   # prints 2
```

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

`npm test` turns telemetry off, and the config fixes one worker and no retries. A new `PILOT_CACHE_DIR` gives a cold run; reusing it gives a warm one. Each run writes `report.json` under its `--output` directory. For every agent step it records the cache mode, model calls, tokens and the actions taken.

`public-results.e2e.ts` has two switches for cache experiments. `PILOT_EXPECT_HEADING=Audio` makes the run fail on purpose. `PILOT_RENAME_LINK="<link text>"` renames that link in the tab before the step. Run a rename against a copy of the cache, because its live run overwrites the recording with the renamed link, which exists only in the test.

Everything under `.e2e/`, including reports, traces and recordings, is gitignored. So are `.dev.vars` and the local database.

## Measured on 3 October 2026 at 3670e55

| Step | Cold | Warm |
| --- | --- | --- |
| Landing to results | 2 model calls, 9,231 tokens, 5.1 s | replayed, 0 calls, 0.4 s |
| Link approval | 6 model calls, 28,400 tokens, 22.8 s | replayed 5 of 5 actions, 0 calls, 15.0 s |

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

- `cogworks check`, `run` and `sync` from a team repository.
- Opening the approval link before joining a team. The portal remembers the link and names it on the next page, but no test here exercises it.
- Any deployed portal, and Modal, GitHub or Discord.
