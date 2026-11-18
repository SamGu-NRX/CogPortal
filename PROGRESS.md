# Progress snapshot: CogPortal-image-build-source-20261001 (20261118)

The local checkout `~/Programming Projects/CogPortal-image-build-source-20261001` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `fix/benchmark-image-build-source-20261001` at `77830c01e6`
- Snapshot branch: `archive/progress-20261118-CogPortal-image-build-source-20261001` (HEAD plus the uncommitted work listed below)
- Last commits:
- 77830c0 2026-10-01 fix(test-env): install pip for the image install test and correct runbooks
- 2b58252 2026-10-01 fix(release): stop requiring a hand-deleted build/ before deploy
- 4850f8c 2026-10-01 fix(runner): keep stale build output out of benchmark image installs
- 2a897a4 2026-10-01 fix(setup): install the CLI from 5c8efc6, the SDK the images bake
- f7f83d4 2026-10-01 Merge #62 (3015c82) into beta
- 03e1544 2026-10-01 Merge #61 (afc71bf) into beta
- afc71bf 2026-10-01 fix(runner): decide an evaluation timeout from the controller's clock only
- ab5fca1 2026-10-01 Merge #60 (585180c) into beta

The working tree was clean; nothing uncommitted was captured.

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-image-build-source-20261001"
git -C "$HOME/Programming Projects/CogPortal-image-build-source-20261001" checkout archive/progress-20261118-CogPortal-image-build-source-20261001
```

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
