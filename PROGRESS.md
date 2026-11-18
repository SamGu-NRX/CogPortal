# Progress snapshot: CogPortal-hosted-readiness (20261118)

The local checkout `~/Programming Projects/CogPortal-hosted-readiness` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `integration/demo-release-20260914` at `20889b519e`
- Snapshot branch: `archive/progress-20261118-CogPortal-hosted-readiness` (HEAD plus the uncommitted work listed below)
- Last commits:
- 20889b5 2026-09-15 merge: take PR23's shortened R2 configuration comments
- 5fe41c4 2026-09-15 docs(release): keep the R2 comments to the staging/production boundary
- cfe924c 2026-09-15 fix(ui): reuse command controls and clarify completed-run quota
- e796932 2026-09-15 Merge commit '4ac0847' into integration/demo-release-20260914
- 4ac0847 2026-09-15 docs(release): keep the release checklist's storage item staging-only
- 4a82769 2026-09-15 Merge commit '046dffa' into integration/demo-release-20260914
- 046dffa 2026-09-15 feat(release): give staging its own private weight bucket
- 0c90726 2026-09-14 Merge commit '4ae27a0' into integration/demo-release-20260914

The working tree was clean; nothing uncommitted was captured.

Git-ignored files that can't be rebuilt (.env files, local data) were copied to `~/MacSetup/worktree-leftovers-20261118/CogPortal-hosted-readiness` on the Mac. They are not on GitHub or Drive.

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-hosted-readiness"
git -C "$HOME/Programming Projects/CogPortal-hosted-readiness" checkout archive/progress-20261118-CogPortal-hosted-readiness
```

Then copy the kept ignored files back: `cp -R "$HOME/MacSetup/worktree-leftovers-20261118/CogPortal-hosted-readiness/." "$HOME/Programming Projects/CogPortal-hosted-readiness/"`, and reinstall dependencies.

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
