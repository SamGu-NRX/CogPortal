# Cog\*Portal

Hosted benchmark control plane for the BWSI CogWorks capstones. Students fork
the course template, connect it here, run the practice benchmark with
actionable diagnostics, promote successful candidates to attempt-limited
official runs, and publish team-selected results to a per-track leaderboard.

**Authoritative plan:** [`handoff-plan.md`](./handoff-plan.md) (supersedes the
earlier draft in `context.md`).

## Status

| Milestone | State |
| --- | --- |
| M0 — Cloudflare Sandbox provider gate (§9) | **Not started** — Workers Paid + pinned SDK/container spike |
| M1 — End-to-end run | ✅ Deterministic fixture execution adapter |
| M2 — Official path + leaderboard | ✅ Promotion, atomic 3-attempt quota, refunds, selection, log suppression |
| M3 — Student experience | ✅ Setup-guide landing, team creation/management, per-track standings |
| GitHub App | ✅ OAuth identity, repo listing, permission + template-fork checks, HMAC webhook |
| M4 — Ronaldo's vision plugin | Blocked on the finalized `vision-recognition/v1` contract + datasets |

Real sandbox execution plugs in behind `worker/execution/adapter.ts` after the
M0 spike; nothing else changes.

## Stack

React 19 + Vite + Tailwind v4 SPA · Hono Worker API · D1 + Drizzle · shared
Zod contract (`shared/schema.ts`) · single Cloudflare deployment. R2,
Workflows, and Containers bindings are staged in `wrangler.jsonc` (commented)
pending Milestone 0.

```
shared/     Zod contract, failure catalog, fixture scenarios  ← both sides
worker/     Hono API, Drizzle schema, auth, GitHub App, fixture engine
src/        SPA (paper/ink design system, shiki code highlighting)
migrations/ D1 SQL
```

## Run locally

```sh
pnpm install
pnpm dev        # applies local D1 migrations, then vite dev
```

Local sign-in (shown while `DEV_AUTH=enabled`) takes any username. Cohort
join code is seeded as `VISION26`. Connecting a repository creates the team —
the first connector names it and becomes its admin (`/team` to manage).
Fixture branch names script run outcomes (`main` succeeds; `missing-adapter`,
`heavy-model`, `raw-tuples`, … fail with their category).

To exercise real GitHub sign-in, copy `.dev.vars.example` → `.dev.vars` and
fill in the GitHub App credentials; set `GITHUB_TEMPLATE_REPO` to enforce
fork-of-template on connect.

## Deploy

1. `wrangler d1 create cogportal-db` → real `database_id` in `wrangler.jsonc`;
   apply migrations remotely.
2. Set `ENVIRONMENT=production`, `DEV_AUTH=disabled`; configure the GitHub App
   secrets.
3. Complete the Milestone-0 sandbox spike before `EXECUTION_PROVIDER=sandbox`;
   fall back to E2B if the spike fails (plan §9).

Public deployment, CogWeb attribution, and any biometric dataset use require
BWSI/MIT confirmation first (plan §11).
