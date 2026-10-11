# Cog*Portal real-journeys harness

Playwright journeys that drive the **real** Cog*Portal stack — the built
SPA, the built Cloudflare Worker over a fresh local D1, and stateful
provider doubles — with network-level shaping instead of mocks.

## Why this exists

The scripted `tools/portal-journey-e2e` fixture server exercises the SPA
against canned HTTP. It cannot answer the questions that break real
users: does the worker's genuine OAuth round trip survive a dropped
connection? Does a duplicated upstream send of a Discord channel create
produce two channels? Do signed sessions survive a cold worker boot?
This harness answers those by running the real worker and shaping only
the network between it and labelled provider doubles.

## Layout

- `playwright.config.mjs` — sequential, one worker, zero retries; traces
  and video are retained for failing journeys.
- `stack/stack.mjs` — `node stack/stack.mjs` supervisor. Builds the SPA
  for production, boots the built Worker through the repo's own
  Cloudflare Vite preview path (`vite preview` + `@cloudflare/vite-plugin`,
  port 8810), applies local D1 migrations and seed data on a fresh boot,
  starts the labelled doubles, and fronts the worker with the shaping
  proxy. The stack boots in the **development** configuration by default
  (dev sign-in enabled, EXECUTION_PROVIDER=fixture).
- `stack/doubles.mjs` — the doubles:
  - **GitHub** on 8813 — OAuth authorize/token, `/user`, org memberships,
    repo sync fixtures; grants are stateful and revocable; every request
    is journaled.
  - **Discord** on 8814 — OAuth token/identity, guild channel create
    (idempotent by channel id), channel/permission validation, run-bubble
    message posting; journaled.
  - **Modal runner** on 8815 — eval execution callbacks with controllable
    latency and failure modes.
- `journeys/helpers.mjs` — session minting through the worker's real
  dev-auth route, fresh-boot orchestration, proxy fault control, D1 SQL
  escape hatch.
- `journeys/j1…j4*.mjs` — the four journeys (below).

## Wiring the seams

The worker reads two optional bindings declared in
`apps/portal/worker/env.ts`:

- `GITHUB_API_BASE_URL` — overrides the GitHub REST/OAuth base URL
  (`apps/portal/worker/github/client.ts` and the OAuth authorize-URL
  builder).
- `DISCORD_API_BASE_URL` — overrides both Discord bot clients and the
  Activity token/identity exchange.

The stack supervisor sets them in the worker's local bindings to point at
the doubles. **No real environment sets these variables** — nothing in
`wrangler.jsonc`, the deploy pipeline, or CI — so production traffic is
byte-for-byte unchanged in destination. The seams exist so the worker's
real outbound code can be exercised end-to-end; they are not feature
flags and do not alter any code path besides the base URL string.

## The journeys

1. **Real GitHub OAuth + membership sync** — the browser performs the
   authorize → code → callback redirect chain against the double; the
   worker exchanges the code and syncs org/team membership through its
   real client; the linkage is visible in the API and the SPA.
2. **Revoked credential** — the double revokes the stored grant; a sync
   maps to the real `credential_revoked` error without unlinking the
   account; the double sees exactly one attempt.
3. **Duplicate-send idempotency** — the proxy duplicates one upstream
   Discord channel-create POST; the journey ends with exactly one channel
   and one membership row.
4. **Mid-journey restart + production refusal** — a signed session
   survives a cold worker boot; a production-configuration boot refuses
   `/api/dev/login` until the development configuration returns.

## Running

```sh
cd tools/portal-real-journeys
npm install            # first time; also: npx playwright install chromium
node stack/stack.mjs   # boots the full stack in the background
npm test               # runs the journeys against it
```

The stack supervisor logs to `stack/.stack/stack.log`; the proxy logs
each shaped request to the same file. Playwright writes traces and video
under `test-results/` for any failing journey.

## Shaping vocabulary (proxy)

`POST /__proxy/faults` with `{ rules: [...] }`, where each rule is

- `match` — `{ host?, path?, method? }` selecting upstream requests,
- one of `delayMs` (hold the request), `dropTimes: n` (swallow the first
  n sends), or `duplicate: n` (send the request n extra times upstream),
- `times` — optional cap on how many matching requests the rule applies
  to.

`POST /__proxy/faults/clear` removes all rules. Rules never touch the
browser↔proxy hop; they shape proxy↔upstream sends only.

## Control endpoints (supervisor, port 8810)

- `POST /__control/fresh` `{ nextProfile? }` — fresh D1 (migrations +
  seed), rebuild the SPA if sources changed, boot the Worker in the
  development configuration with the seam bindings.
- `POST /__control/restart-worker` — cold-boot the Worker in place
  (same D1, same assets).
- `POST /__control/prod-boot` / `POST /__control/dev-boot` — boot with
  production / development configuration.
- `POST /__control/sql` `{ sql }` — D1 escape hatch for assertions
  (read-mostly; journeys assert counts through it).

## Doubles' control endpoints

Each double serves `GET /__doubles/<provider>/journal` (recorded
requests) plus provider-specific state routes — e.g. GitHub
`POST /__doubles/github/revoke { login }`, Discord
`GET /__doubles/discord/channels/:id`.
