# Production CPU per route, and the Sept 15 sign-in failure

Read-only. No production, billing or secret change. Deployed source read at `20889b5`.

## Direct answer: did the OAuth callback exceed the 10 ms ceiling at demo time?

**No.**

Not from telemetry, which does not exist for that window (see "Why the tables are empty"), but from what Sam saw. The page rendered the application's own sentence, and a Worker killed by the CPU limit cannot render anything.

| Evidence | Location | What it establishes |
|---|---|---|
| `oauthError.includes("denied") ? … : "GitHub sign-in failed. Try again."` | `apps/portal/src/routes/SignInPage.tsx:95-97` | The exact copy Sam reported. It renders only when the SPA loads `/signin?error=<code>` with a code not containing "denied". |
| `errorCallbackURL: "/signin"` | `apps/portal/worker/routes/github.ts:77-81` | Better Auth appends `?error=<code>` and redirects there on a failed callback. |
| `type ApiStatus = 400\|401\|403\|404\|409\|410\|413\|500\|501\|502` | `apps/portal/worker/http/errors.ts:1` | The app has no 503 in its vocabulary; a resource-limit failure is emitted by the platform, not the app. |

The chain that must have run: the callback request reached the Worker, Better Auth processed it and judged it failed, the Worker issued a 302 to `/signin?error=…`, the browser loaded the SPA, and the SPA read the param and rendered its own styled copy. A request terminated by `exceededResources` returns Cloudflare's own 1102 error page instead — no redirect, no app markup, no app sentence.

So the sign-in failure was an **application-level OAuth rejection**, and the specific reason travelled in the `?error=` code in the URL Sam had on screen.

**Unproven hypothesis, flagged as such.** `accountLinking: { enabled: false }` at `apps/portal/worker/auth/better-auth.ts:87`. With linking disabled, a GitHub identity whose email matches an existing user row is refused rather than linked, which fits "an existing GitHub account" failing. There is no evidence for this beyond the configuration; the actual error code was in the URL and was not captured.

## Why the per-route tables are empty

The requested tables cannot be produced, and would not have been available even with a working analytics credential.

| Barrier | Evidence | Consequence |
|---|---|---|
| No route dimension | `workersInvocationsAdaptive` exposes `scriptName`, `status`, `datetimeMinute`/`datetimeHour`. No request path or route. | CPU is reported per script invocation. Per-route p50/p99 has never been derivable from this dataset. The per-route breakdown obtained on Sept 15 came from live `wrangler tail`, not GraphQL. |
| Route logging never enabled | `GET /accounts/…/workers/scripts/cogportal-production/settings` → `"observability": null` (REST, succeeded 2026-09-18) | No retrospective per-request record with URL and CPU exists for any past window. |
| Window is three days past | Demo window 2026-09-15 19:45–21:15 UTC | `wrangler tail` is live-only and cannot reach backwards. |
| Analytics endpoint denied today | Cloudflare GraphQL → `{"code":10000,"message":"Authentication error"}`; REST on the same credential succeeds | Two calls made, then stopped per instruction. The credential is alive; this endpoint is refused. |

Counts, p50/p99, `exceededResources` totals and worst-p99 minutes are therefore **not reported for any route** rather than estimated. Enabling Workers Observability on the production script is the prerequisite for ever answering this question properly; it is a production configuration change and was not made.

## Three highest CPU cost per request, from the deployed source

Ranked by JavaScript work per request read at `20889b5`. This is a code reading, not a production measurement.

| Rank | Route | DB round trips per request | Other per-request work |
|---|---|---|---|
| 1 | `GET /api/dashboard` | **9 + N**, N = runs serialized (capped 50) | session verification; fresh Better Auth instance; fresh Drizzle client per `getDb` |
| 2 | `GET /api/runs/:id` | **5** | session verification; same two per-request constructions |
| 3 | `GET /api/auth/callback/github` | 2 fixed + rate-limit read/write | AES encryption of OAuth access and refresh tokens; session row creation |

### 1. `GET /api/dashboard` — `apps/portal/worker/routes/dashboard.ts`

Nine awaited statements before serialization: `requireTeam` (:28), benchmark lookup (:31), `syncTeamRuns` (:43), all team runs (:44), `readRunAccounting` (:55, two aggregates), leaderboard selection (:58), selected run (:72), its primary metric (:77). Then `serializeRunSummary` issues **one `runMetrics` query per run** (`http/serializers.ts:74`) across `allRuns.slice(0, 50)` (:99), plus one more for `activeRun` (:123) and one for `latestCandidate` (:126).

A team with 20 runs therefore performs roughly 30 sequential D1 statements for one page view.

**Smallest change.** Replace the per-run metric query with a single `inArray(runMetrics.runId, ids)` read for the page's runs and group in memory, and lower the `slice(0, 50)` to the number the UI actually renders. One query replaces up to fifty. No cache, no retry, no timeout, no new dependency.

### 2. `GET /api/runs/:id` — `apps/portal/worker/routes/runs.ts`

Five statements: the run row, then phases (`serializers.ts:125`), metrics (:126), leaderboard selection (:128) and the benchmark row (:142).

**Smallest change.** Phases, metrics and selection are independent. Issue them as one `db.batch([...])` so three round trips become one. `db.batch` is already the house pattern — `execution/sync.ts:77`, `routes/runner-events.ts:137`, `services/run-actions.ts:456` — so this introduces no new machinery.

### 3. `GET /api/auth/callback/github` — Better Auth handler

Per request: `encryptOAuthTokens: true` (`auth/better-auth.ts:86`) encrypts the access and refresh tokens on every sign-in; `rateLimit.storage: "database"` (:81-84) adds a D1 read and write; and `authFor` constructs a **new Better Auth instance for every request** (`auth/session.ts:60-62`), which builds the endpoint table and adapter each time.

**Smallest change.** Build the Better Auth instance once per isolate instead of per request. Its inputs are the environment and, for our configuration, nothing request-scoped: `geolocationTracking: false` means the `cf` object is never read on a normal request, and the IP comes from the `cf-connecting-ip` header. This is the documented usage; per-request construction is our deviation. It is the largest single removable item on this route, and it also lifts routes 1 and 2.

Caveat carried from the Sept 15 measurements: a local experiment memoising that instance produced **no** measurable end-to-end gain (10.43, 11.13, 11.18 ms/req against 10.92, 10.98 baseline). The argument for it is removing duplicated construction, not a demonstrated speed-up. Encryption and rate-limit storage are security behaviour and are not proposed for removal.

## Is PR #38's 0.96 ms visible on production?

**No, and it is not measurable there as configured.**

- PR #38 is **not deployed**. Production runs Worker `e4d04128`, which predates it.
- With `observability: null` there is no per-route production measurement in which an effect of that size could appear.
- Whole-script CPU p50 varies between roughly 6,000 and 16,000 µs minute to minute; the claimed effect is 960 µs, six to sixteen times smaller than the swing it would have to be seen through.
- Locally the whole-request total moved by less than the ±0.4 ms run-to-run spread. The 0.96 ms is frame self-time attributed to `extractTablesRelationalConfig` and `drizzle`, removed work rather than observed latency.

The claim that survives is narrow: PR #38 removes repeated construction. No end-to-end gain has been demonstrated anywhere, and none is observable on production.

## Ordering for a free plan

Route 1's N+1 is the only item here that scales with a team's run count, so it is the one that grows toward the ceiling as the cohort uses the portal. It is also the smallest diff of the three. Routes 2 and 3 are fixed costs.
