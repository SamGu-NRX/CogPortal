# Progress snapshot: CogPortal-integrate-20260930 (20261118)

The local checkout `~/Programming Projects/CogPortal-integrate-20260930` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `integration/verified-fixes-20260930` at `1d058736a0`
- Snapshot branch: `archive/progress-20261118-CogPortal-integrate-20260930` (HEAD plus the uncommitted work listed below)
- Last commits:
- 1d05873 2026-09-30 docs: match the local-reports, admin and process-signal docs to the candidate
- afaa527 2026-09-30 Merge b79dadd (docs: bring the student guide to 9524d0f and add an instructor guide) into the integration candidate
- 6ea5390 2026-09-30 Merge 4900661 (fix(portal): repair defects found in the phone-to-desktop browser pass) into the integration candidate
- 39d9ef1 2026-09-30 Merge 4bd64cb (fix(db): keep demo teams and the published join code out of hosted databases) into the integration candidate
- e9e60c7 2026-09-30 Merge 4737aaf (fix(portal): read every admin team summary in one pass) into the integration candidate
- 1675448 2026-09-30 Merge #50's saved-Vision fake fix into the integration candidate
- c4901e5 2026-09-30 test(runner): let the saved-Vision reuse fake take exec's text keyword
- 3d4f43f 2026-09-30 test(runner): give the scorer guard the one RunnerFailure from failure.py

The working tree was clean; nothing uncommitted was captured.

Git-ignored files that can't be rebuilt (.env files, local data) were copied to `~/MacSetup/worktree-leftovers-20261118/CogPortal-integrate-20260930` on the Mac. They are not on GitHub or Drive.

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-integrate-20260930"
git -C "$HOME/Programming Projects/CogPortal-integrate-20260930" checkout archive/progress-20261118-CogPortal-integrate-20260930
```

Then copy the kept ignored files back: `cp -R "$HOME/MacSetup/worktree-leftovers-20261118/CogPortal-integrate-20260930/." "$HOME/Programming Projects/CogPortal-integrate-20260930/"`, and reinstall dependencies.

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
