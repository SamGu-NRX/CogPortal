# CogPortal local readiness gate

One command that runs the local readiness surfaces the real-user readiness plan
([docs/plan/real-user-readiness.md](../../docs/plan/real-user-readiness.md))
gates on, reports each surface separately, and fails — naming the affected
surface — when a surface is broken or its evidence cannot be verified.

```sh
pnpm readiness            # all three surfaces
```

It composes evidence that already exists rather than introducing new harnesses:

| Surface | Plan | What runs | Passes when |
| --- | --- | --- | --- |
| `portal` | S1–S6 | `tools/portal-concurrent-member-journeys` (Playwright) against the real local stack: Vite + Worker + a fresh local D1, dev sign-in, no route mocks | exit 0 and the JSON report shows journeys run with zero unexpected results; zero journeys or an unreadable report counts as unverified and fails |
| `cli` | S7 | the real `cogworks check --json` readiness decision on three synthetic fixture repositories: a ready one, one whose submission raises on import, one whose submission ends the interpreter (`os._exit`) | the ready fixture answers the CLI's own five-key readiness decision with exit 0; both broken fixtures answer truthfully (exit 2) with structured JSON — a crash report, not a crash |
| `cogbot` | S8 | the interaction Worker's documented local verification: `pnpm --filter @cogworks/discord-bot check`, `test`, `build` | all three exit 0 and the node:test summary parses with zero failures and at least one pass |

The CLI surface uses the repo's own v1 public fixture (`benchmarks/vision-recognition`)
and example adapter shape (`examples/week2-vision-submission`), so it needs no
network, no model weights, and no course data. The `ready` verdict is the CLI's
own (`python/cogbench/src/cogbench/cli.py`, the `required` tuple in `_check`):
`gitRepository`, `repositoryFullName`, `benchmarkInstalled`, `benchmarkLoadable`,
`submissionLoadable`.

## What it does not do

Nothing here touches production or beta, GitHub, Discord, Modal, hidden course
data, CI workflows, deploys, or paid services. The identities are synthetic (dev
sign-ins, `team-synthetic-2026` as the fixture repository's origin). The only
network use is environment preparation — dependency installation from the repo's
own lockfiles, editable local pip builds, and Playwright's browser and OS-library
installation when a launch probe shows they are missing; the checks themselves
talk to localhost only. The v1 fixture plugin is installed
with `--no-deps` because its `cogworks-benchmark <0.2` pin predates this
checkout's 0.2.0; it imports only `cogbench.models`, which 0.2.0 provides.

## Isolation on a shared machine

The portal surface boots its own stack on port `5399` (override with
`JOURNEYS_PORT`) and passes `JOURNEYS_REUSE_STACK=0` to the journeys suite, so
Playwright always boots a fresh stack for this run instead of reusing a server
it did not start — on a shared checkout machine, a reused server is somebody
else's world. If the port is already taken, the surface fails with that reason
rather than testing an unknown stack. See the suite README for the two
environment knobs the gate relies on.

## Failure injection (self-test)

The gate can mark a surface failed without running it, to prove the failure
path: the report names the affected surface, the human summary lists it, and
the process exits nonzero.

```sh
pnpm readiness -- --surface=cli --inject-failure=cli   # exits 1, names cli
```

## Options

```sh
pnpm readiness -- --surface=portal,cli     # a subset, comma-separated
pnpm readiness -- --report=/tmp/report.json --print-report
pnpm readiness -- --skip-install           # assert dependencies exist; never install
```

## Machine-readable result

Every run writes a JSON report (default
`tools/readiness-gate/.cache/readiness-report.json`, override with `--report`):
overall `ready` / `not-ready`, and per surface the status, evidence counts,
every command with its exit code, the failure reason naming the surface, and
whether the failure was injected.
