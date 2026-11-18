# Progress snapshot: CogPortal-mergeplan-dryrun-C (20261118)

The local checkout `~/Programming Projects/CogPortal-mergeplan-dryrun-C` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `mergeplan/dryrun-C` at `3411be7d86`
- Snapshot branch: `archive/progress-20261118-CogPortal-mergeplan-dryrun-C` (HEAD plus the uncommitted work listed below)
- Last commits:
- 3411be7 2026-09-30 dryrun: merge #48 (d0b65275)
- 4fbd0d1 2026-09-30 dryrun: merge #43 (cdd9adce)
- d2ca288 2026-09-30 dryrun: merge #21 (cf4e3a48)
- 6dc7d2a 2026-09-30 dryrun: merge #20 (75ec3cbb)
- 52049cd 2026-09-30 dryrun: merge #18 (9c651d0d)
- 2cecacd 2026-09-30 dryrun: merge #14 (d50be7b8)
- 6e17c23 2026-09-30 dryrun: merge #11 (81971b97)
- 7600757 2026-09-30 dryrun: merge #2 (fda98554)

The working tree was clean; nothing uncommitted was captured.

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-mergeplan-dryrun-C"
git -C "$HOME/Programming Projects/CogPortal-mergeplan-dryrun-C" checkout archive/progress-20261118-CogPortal-mergeplan-dryrun-C
```

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
