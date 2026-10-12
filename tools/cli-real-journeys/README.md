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
| Portal SPA | real | the production build, served by the same Worker; every device approval is a real Chromium pressing its button once |
| `cogworks` CLI | real | this commit's source, and each staging pin's `COGBENCH_SOURCE`, installed by pip into new virtual environments every run, with the installed commit asserted |
| Week 1/2/3 benchmarks | real | installed from the pinned commits in `apps/portal/src/lib/benchmark-packages.ts` |
| Week data | real | Week 1 renders its corpus; Week 2 reads the public split through its `[data]` extra; Week 3 fetches the three public course files with size and sha256 pins |
| GitHub OAuth | double | never configured; sign-in uses the Worker's development auth, which only exists when OAuth is unset |
| Discord REST API | double | a loopback HTTP server that speaks the interaction-webhook protocol; every receipt names it `discord-api-double` |
| Modal runner | untouched | hosted runs use the Worker's fixture execution provider, locally |

The suite never stubs the app's own requests. The network shaper sits in front
of the Worker, where it can delay, drop or fail requests; it does not answer
for the Worker. The Discord double exists because Discord itself is out of
bounds (dev and prod share one application, guild and bot). The public-data
journeys route the CLI through an egress proxy that allows loopback and the
documented asset hosts (`support/egress-hosts.mjs`); any other attempt, even
one the proxy refused, fails the case.

## Running it

```sh
PY38=python3.8 PY311=python3.11 PY313=python3.13 bash tools/cli-real-journeys/run-all.sh
```

Prerequisites: Node 24, the repository's `pnpm install`, Python 3.8, 3.11 and
3.13 interpreters, git, curl, and Playwright's headless Chromium
(`npx playwright-core install chromium-headless-shell` in this directory).

One command builds the portal and bot, applies migrations and seed to a fresh
D1, creates new virtual environments for this run from the three
interpreters, boots the stack and runs every journey with retries off. It
exits nonzero if any required case failed and writes `results/` (gitignored):
one receipt per case, each naming the commit under test, and `summary.md`.
The run's environments and downloaded data live in its scratch directory under
`/tmp` and are deleted when it ends (`KEEP_ENVS=1` keeps them). A full pass
downloads the Week 2 model stack and about 1 GB of Week 3 data per Week 3
environment, so it needs roughly 15 GB free.

`.github/workflows/cli-real-journeys.yml` runs three full passes per pushed
commit on fresh runners and uploads each pass's `results/` as an artifact named
for the commit. `bash tests/run.sh` runs the suite's own tests without the
stack.

## Layout

- `run-all.sh` is the whole run, in eight numbered stages.
- `support/stack.mjs` boots the stack behind one readiness check: the
  fresh-D1 Worker with the built SPA, the CogBot Worker bound to it, the
  Discord double, and the network shaper (which also records each request
  line it forwards, method and path only).
- `support/cli.ts` runs the installed `cogworks` the way a student's terminal
  would: fresh `HOME`, no inherited `GIT_*` variables, stdout, stderr and exit
  code captured, and Ctrl-C delivered to the process group.
- `journeys/` holds one file per area: setup and link, the benchmark runs and
  CogBot, adversarial faults, every command on each Python
  (`cli-commands.ts`), the staging pins, and the Week 2/3 public-data runs.
  `journeys/harness.ts` writes one receipt per case (commands, exit codes,
  outputs, which pieces were doubles); `support/report.mjs` aggregates them.

## Windows

The workflow's `helpers` job runs the suite's Python helpers on
`windows-latest` with Python 3.8, including a real pip install read back
through the native `Lib/site-packages` layout. The journeys themselves run on
Linux; CI's main Python lane runs the CLI's own tests and smoke on Windows.
