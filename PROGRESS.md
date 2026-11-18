# Progress snapshot: CogPortal-care-hosted (20261118)

The local checkout `~/Programming Projects/CogPortal-care-hosted` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `care/hosted-release` at `60357f003d`
- Snapshot branch: `archive/progress-20261118-CogPortal-care-hosted` (HEAD plus the uncommitted work listed below)
- Last commits:
- 60357f0 2026-09-29 docs(evidence): record the Sept 29 review dispositions for the hosted group
- 400c685 2026-09-19 docs(evidence): record how #1's sweep was merged up the hosted group
- 218c1c5 2026-09-18 docs(evidence): record the hosted caretaker landing table and pin values
- c14b364 2026-09-18 chore: declare project icon for T3 Code
- 7ea1f14 2026-09-16 ci: have Greptile re-review every push
- 8a1e4f4 2026-09-16 ci: review stacked pull requests with CodeRabbit
- 2747b67 2026-08-19 fix: correct audited benchmark defects and give week 1 a real validator
- 183a5e0 2026-08-19 docs: record the query rungs and the stale-build failure in the runbook

The working tree was clean; nothing uncommitted was captured.

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-care-hosted"
git -C "$HOME/Programming Projects/CogPortal-care-hosted" checkout archive/progress-20261118-CogPortal-care-hosted
```

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
