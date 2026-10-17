# tools/runner-real-journeys

Adversarial end-to-end journeys for surface S10 of `docs/plan/real-user-readiness.md`
(PR #108): the runner's real controller, sandbox and scorer, driven through the real
portal Worker and D1, with the submissions a student actually writes on a Tuesday —
ordinary broken code, never cheating.

The journey runner itself is **not built yet** — there is no
`run-journeys.mjs` and no stub stands in for it; the entry point appears here
when the first journey lands. What exists today is the stack it will drive,
started by hand:

```
bash tools/runner-real-journeys/stack/bootstrap.sh            # edge + runner, suite-only trust
sudo -E bash tools/runner-real-journeys/stack/setup-host.sh   # local CA, certs, private hosts file
python3 tools/runner-real-journeys/stack/build_envs.py        # course venv stacks
```

The full design — lanes, corpus, receipt format — lives in this file and in
`CONTRACTS.md`.

## What is real

- The runner controller: `apps/runner-modal/src/cogworks_runner/modal_app.py`, run
  verbatim — `submit_job`, `execute_job`, `_run_claimed`, `_prepare`, all four
  `_evaluate*` lanes, prediction validation, scoring, and callback delivery. The
  local runner imports the module with the same modal-module stub technique
  `tools/image_manifest.py` uses, and serves the same signed HTTP endpoint the
  deployed Modal function serves.
- The sandbox: student code runs under `sudo unshare --mount` (plus `--net` where
  the job blocks network) with `/tmp` and `/workspace` bind-mounted to the sandbox's
  private directories, and `prlimit` ceilings for address space, CPU, file size and
  process count. Timeouts kill the process group. The real prepare script runs in it:
  it downloads the source archive, resolves the binding, and snapshots the
  filesystem the same way (`snapshot_filesystem` is a tar of the sandbox's private
  trees that the evaluate sandbox restores from).
- The scorer: `benchmark.score(...)` and the v2 metric shaping, in the controller,
  on the benchmark plugins from the pinned submodules.
- The portal: `pnpm dev` (Vite + Worker plugin) on a fresh local D1 (migrations +
  `scripts/seed-local.sql` wiped per journey), with `EXECUTION_PROVIDER=modal`,
  `MODAL_RUNNER_URL` pointed at the local runner and `RUNNER_SIGNING_SECRET` set in
  `.dev.vars` — the Worker's normal configuration, no code fork.
- The run page: driven with Playwright against the served SPA; the leaderboard is
  checked signed out.

## What is doubled (named)

- **Modal itself** — the named gate. `modal.Sandbox` is replaced by the local
  namespace/prlimit sandbox above. The deployed images, their baked dependency
  versions, and Modal's own enforcement are not exercised. Gate command recorded in
  the Handoff.
- **GitHub REST** — the plan allows a double. `api.github.com` is answered by
  the suite's HTTPS edge (`stack/edge.py`, trusted via the suite's local CA,
  scoped to suite processes) that serves source tarballs; the fixture repository `cogworks-demo/face-finder`
  keeps the Worker off real GitHub entirely (`FixtureGitHubClient`). No real OAuth.
- **Discord** — never called. Nothing in this suite touches discord.com.

## Journey lanes

- `broken-code` — per week, a corpus of realistic broken submissions (see
  `corpus/CASES.md`), each started through the run API the SPA calls, as a dev-auth
  student. Pass bar per case: the runner, controller and scorer survive; the run
  ends scored or in a categorized failure whose category, phase and message are
  true against what the submission did; no run stays in `evaluating` past the time
  limit plus the stale sweep; nothing from one team appears in another's result or
  log; the signed-out leaderboard still renders.
- `concurrency` — a good run from a second team on the same runner, started while a
  bad run is mid-evaluation, finishes unaffected with the reference score.
- `callbacks` — lost, duplicated, reordered and late events, a bad signature, and a
  Worker restart mid-run, through a shaping proxy in front of the callback route.

## Isolation differences to know about

- Prepare-phase outbound domains (GitHub, PyPI) are not filtered by the local
  sandbox; Modal enforces the allowlist in production. Evaluation sandboxes run
  with no network at all (`unshare --net`), which is stronger than production's
  `block_network` for the same flag.
- Memory ceilings are `RLIMIT_AS` rather than a cgroup; a submission that allocates
  without touching pages reads as surviving where Modal's memory.max would kill it.
  The corpus's memory case writes through what it allocates.
- The runner's job store is a process-local dict, not a Modal Dict; a killed local
  runner loses claims the deployed one survives. The Worker-restart case restarts
  the portal, never the runner, and the replay/retry rules the store backs are
  exercised through it.
