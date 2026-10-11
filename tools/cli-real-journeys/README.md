# CLI real journeys

An adversarial end-to-end suite for the two surfaces a student drives from a
terminal and Discord: the `cogworks` CLI (S7) and CogBot (S8). It is the
`tools/cli-real-journeys/` half of the harness described in
`docs/plan/real-user-readiness.md` (PR #108); results are reported against that
plan's metrics M1 (complete journeys), M2 (adversarial classes), M5 (documented
install on every supported Python) and M6 (every defect has a witness and a
fix or a decision).

Everything here runs against the real local stack: the built portal SPA and its
Worker on a fresh local D1, the real CogBot Worker with its real service
binding to the portal's `PortalRpc` entrypoint, and the real `cogworks` CLI
installed the way the setup page installs it. Nothing reaches a deployed
portal, Discord, GitHub OAuth or Modal.

## What is real and what is a double

| Piece | Real or double | Which |
| --- | --- | --- |
| Portal Worker, routes, D1, auth | real | built worker bundle, migrations and seed via the repo's own dev path; fresh D1 per full run |
| Portal SPA | real | the production build, served by the same Worker |
| `cogworks` CLI | real | installed by pip from the pinned `COGBENCH_SOURCE`, and from this branch's source, into fresh virtualenvs |
| Week 1/2/3 benchmarks | real | installed from the pinned commits in `apps/portal/src/lib/benchmark-packages.ts` |
| Week data | real | Week 1 renders its corpus; Week 2 reads the public split through its `[data]` extra; Week 3 fetches the three public course files with size and sha256 pins |
| GitHub OAuth | double | never configured; sign-in uses the Worker's development auth, which only exists when OAuth is unset |
| Discord REST API | double | a loopback HTTP server that speaks the interaction-webhook protocol; every receipt names it `discord-api-double` |
| Modal runner | untouched | hosted runs use the Worker's fixture execution provider, locally |

The suite never stubs the app's own requests. The network shaper sits in front
of the Worker, where it can delay, drop, duplicate or fail responses; it does
not answer for the Worker. The Discord double exists because Discord itself is
out of bounds (dev and prod share one application, guild and bot).

## Running it

```sh
bash tools/cli-real-journeys/run-all.sh
```

One command: checks the prerequisites (Node 24, a Python 3.8 for the course
environments, Playwright's Chromium), tears any previous state down, applies
migrations and seed to a fresh local D1, builds the portal, boots the stack,
installs the CLIs, and runs every journey with retries off. It exits nonzero
if anything failed and writes `results/` (gitignored) with the per-surface,
per-metric report and every receipt.

Prerequisites the suite expects on PATH or under `$CONDA_ROOT`
(default `/home/user/work/miniconda3`): conda environments `week1`, `week2`,
`week3` (Python 3.8, the course's names) plus `py311` and `py313` for the
version matrix. `run-all.sh` creates the missing ones with `conda-forge`.

Individual journeys: `npx playwright test journeys/week3.spec.ts` after
`run-all.sh --setup-only`.

## Layout

- `support/stack.mjs` boots the whole local stack behind one readiness check:
  fresh-D1 Worker with the built SPA, the CogBot Worker bound to it, the
  Discord double, and the network shaper.
- `support/cli.ts` runs the installed `cogworks` binary the way a student's
  terminal would: fresh `HOME`, no inherited `GIT_*` variables, capture of
  stdout, stderr and exit code, and SIGINT/`SIGKILL` journeys.
- `journeys/` holds one spec file per area: installs (`M5`), each week's data
  journey, link/sync, and CogBot. Each case asserts the three M2 properties
  when it applies: the user's data survives, what they see is true, and there
  is a next action.
- `support/receipts.ts` writes one receipt per case (commands, exit codes,
  outputs, which pieces were doubles) under `results/`.

## Windows

CI's Python lane already runs this repo's own unittest suite and the CLI smoke
(`cogworks --version`, `--help`) on `windows-latest` with Python 3.8; the
install journeys here are plain stdlib Python (`py/install-journeys.py`) so the
same file runs there unchanged. What a Linux run of this suite cannot see, and
which still needs a real Windows machine, is listed in the PR's Handoff under
"What Sam must provide".
