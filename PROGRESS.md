# Progress snapshot: CogPortal-flow-fixture-20260930 (20261118)

The local checkout `~/Programming Projects/CogPortal-flow-fixture-20260930` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `fix/flow-fixture-20260930` at `aee2012c10`
- Snapshot branch: `archive/progress-20261118-CogPortal-flow-fixture-20260930` (HEAD plus the uncommitted work listed below)
- Last commits:
- aee2012 2026-09-30 fix(portal): tell a fixture failure in the track it ran on
- 9524d0f 2026-09-29 chore(setup): install the release candidate's own SDK
- 40d31a2 2026-09-29 fix(cogbench): let the wall clock decide when a check runs threads
- a13c667 2026-09-29 chore(release): pin Language #5's head
- d14a51e 2026-09-29 docs: add the environments, security and deploy guides for this config
- b24b33c 2026-09-29 chore(setup): install the reviewed head of the SDK PR
- 70513b1 2026-09-29 fix(cogbench): check retained weights before sync posts the report
- 074b459 2026-09-29 fix(portal): keep stored history invisible to a rolled-back route

The working tree was clean; nothing uncommitted was captured.

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-flow-fixture-20260930"
git -C "$HOME/Programming Projects/CogPortal-flow-fixture-20260930" checkout archive/progress-20261118-CogPortal-flow-fixture-20260930
```

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
