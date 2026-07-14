# ADR 0001: execution and service boundaries

Status: accepted for the first externally tested release; Modal remains gated
until M0 passes.

## Decision

Use Cloudflare for the portal, Discord interactions, D1, and queue; use Modal
for untrusted Python installation/evaluation; keep CogBench as a separate
offline-first Python distribution; and keep student templates in separate
course-owned GitHub repositories referenced by immutable catalog metadata.

CogBot communicates with CogPortal through a typed Cloudflare service binding.
Modal communicates through versioned, HMAC-signed jobs/events. Neither service
receives direct D1 access.

## Why

- Modal provides filesystem snapshots, per-sandbox CPU/memory/time bounds, a
  preparation domain allowlist, and full evaluation network blocking while
  staying native to the Python-heavy student workflow.
- Cloudflare Workers are a good fit for short Discord interactions and the
  existing portal, but the execution provider should not dictate the web
  control plane.
- An interactions-only bot avoids a persistent gateway process and gives the
  course a small, auditable command surface.
- A stdlib-only CLI core supports Python 3.8+ and remains usable when CogPortal
  or student Wi-Fi is unavailable.
- Separate template repositories preserve normal fork provenance, classroom
  collaboration, and independent starter releases. Submodules would make the
  student path harder without strengthening trust.

## Alternatives considered

- Cloudflare-only sandboxing: attractive operationally, but it remains a
  fallback until its isolation, Python install ergonomics, snapshots, and
  resource controls beat the Modal M0 results for this workload.
- GitHub Actions as the runner: familiar, but queue latency, log/secret
  boundaries, hidden dataset handling, and arbitrary-fork safety are worse for
  attempt-limited evaluation.
- E2B or a bespoke container service: viable fallback, but adds another API or
  substantial operations before a demonstrated Modal limitation.
- A gateway-based Discord process: necessary for presence and event streams,
  neither of which belongs in the dependable MVP.
- Giving the bot a D1 binding: fewer calls, but duplicates authorization and
  couples bot deploys to the database schema.
- One Python package for CLI, plugins, and runner: convenient initially, but it
  would force trusted infrastructure dependencies onto student machines and
  make versioning unclear.
- Git submodules for templates: rejected because students need ordinary forks,
  not nested repository mechanics.
- Nx/Turborepo now: deferred. pnpm recursive scripts already express the small
  graph; another tool is justified only by measured build cost.

## Consequences

The platform has explicit deployment ordering and two runtimes, and protocol
compatibility must be tested. In return, compromise and failure domains are
small: the bot cannot read the database, local reports cannot become official,
and evaluation sandboxes cannot see hidden labels or service credentials.
