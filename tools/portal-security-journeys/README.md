# CogPortal security and isolation journeys

Adversarial security suite for the portal, per `docs/plan/real-user-readiness.md`
(on #108): surface **S5 (Authorization)** and attack classes **A2** (two tabs or two
devices), **A3** (stale cache after a role or team change) and **A10** (revoked or
expired credentials mid-journey), across every surface the Worker serves.

## What runs

One command runs everything:

```
node --run test:security        # added to apps/portal/package.json as milestones land
```

The stack under test is the plan's real local stack:

- the portal Worker through `apps/portal`'s own dev path (wrangler dev),
- a fresh local D1 per journey with every migration applied and `scripts/seed-local.sql`,
- the production SPA build,
- dev-auth sign-in (enabled only when GitHub OAuth is unset),
- labelled stateful HTTP doubles only for GitHub OAuth/REST, Discord and the Modal
  runner — each speaks the provider's protocol and is named as a double in every
  receipt. The app's own requests are never intercepted (`route.fulfill` /
  `page.route` are not used against app origins).

The GitHub double serves at least three accounts with distinct orgs, repos and
permissions, so leakage of one account's repositories into another's view is
observable.

## Coverage (builds out as milestones land)

- object-level access on every id-bearing API route and page (runs, run surfaces,
  teams, reports, local reports, device codes, connections, admin and staff routes,
  Activity routes, leaderboard publication): other team, other cohort, removed
  member, revoked TA, signed out;
- GitHub data isolation: repository lists, forks and team settings never show
  another account's repositories, including after sign-out/sign-in as a different
  user in the same browser and with two concurrent sessions;
- sessions: fixation, logout and revocation actually ending access in every open
  tab and CLI link, cookie flags, CSRF on every state-changing route, CORS, the
  OAuth state and redirect parameters (open redirect) through the double;
- the device-code flow: approving a code another person generated (phishing),
  brute-forcing or replaying codes, expiry, rate limits, and what the approval
  screen tells the user about which device and team they are linking;
- injection: team names, repository names, report fields, finding text and Markdown
  rendered in the SPA and the Activity (stored XSS), and any export;
- forgery: runner callbacks and Discord interactions with bad, replayed or stale
  signatures; host or query spoofing that selects the Activity frontend;
- configuration: dev auth refused in the production wrangler config, no secrets or
  private fields in the client bundle or any API response, diagnostics and logs
  never visible to another team.

## Reporting

Results are reported per metric **M3** (every role x route cell matches policy at
the API and in the UI) and **M6** (P0 is 0; every other defect has a witness and a
fix or an open decision) in the branch PR's Proof section.

Defects in files this task does not own are committed here as a failing witness
plus a proposed patch under `patches/`, never applied to app files; the web task
(`obv/focus-cogportal-web-real-journeys-20261011`) integrates them.
