# Progress snapshot: CogPortal-care-sdk (20261118)

The local checkout `~/Programming Projects/CogPortal-care-sdk` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `care/sweep-32` at `5042fcbf2a`
- Snapshot branch: `archive/wip-20261118-CogPortal-care-sdk` (HEAD plus the uncommitted work listed below)
- Last commits:
- 5042fcb 2026-09-29 Merge branch 'care/sweep-12' into care/sweep-32
- c91cfaf 2026-09-29 Merge branch 'care/sweep-9' into care/sweep-12
- 768988a 2026-09-29 Merge branch 'care/sweep-7' into care/sweep-9
- 7c35189 2026-09-29 fix(cogbench): import the CLI before a fresh child can see the repository
- 2c3ce22 2026-09-29 fix(cogbench): refuse a folder name that resolves to the run's own directory
- 87e015d 2026-09-18 Merge branch 'care/sweep-12' into care/sweep-32
- 494ce24 2026-09-18 Merge branch 'care/sweep-9' into care/sweep-12
- a0adc3d 2026-09-18 docs(migrations): say why language-search v1 moves in place

Uncommitted work captured in this branch (1 paths):

- `openprs.txt`

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-care-sdk"
git -C "$HOME/Programming Projects/CogPortal-care-sdk" checkout archive/wip-20261118-CogPortal-care-sdk
```

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
