# Progress snapshot: CogPortal-student-recovery-20261003 (20261118)

The local checkout `~/Programming Projects/CogPortal-student-recovery-20261003` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `ux/student-recovery-20261003` at `2eb3990315`
- Snapshot branch: `archive/progress-20261118-CogPortal-student-recovery-20261003` (HEAD plus the uncommitted work listed below)
- Last commits:
- 2eb3990 2026-10-03 fix(restore-gate): any focus replaces a first session read still in flight
- 011c737 2026-10-03 docs(product-description): record 1a2887b's blur-time account record
- 1a2887b 2026-10-03 fix(restore-gate): record who the page was painted for when the window blurs
- 4704bd0 2026-10-03 fix(team): keep Leave's armed state and consequence in the same component
- 39e914c 2026-10-03 fix(team): team settings writes require the actor to be an admin when they run
- 3daae33 2026-10-03 docs(product-description): record a6eef75's admission-time job and refusals
- a6eef75 2026-10-03 fix(runs): admit every Modal run with the job it will be sent with
- d6ead00 2026-10-03 docs: state the leave guarantee precisely; tidy useLeaveTeam

The working tree was clean; nothing uncommitted was captured.

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-student-recovery-20261003"
git -C "$HOME/Programming Projects/CogPortal-student-recovery-20261003" checkout archive/progress-20261118-CogPortal-student-recovery-20261003
```

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
