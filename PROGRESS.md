# Progress snapshot: CogPortal-care-ci-20260922 (20261118)

The local checkout `~/Programming Projects/CogPortal-care-ci-20260922` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `care/ci-pr31-20260922` at `9dcacf3bed`
- Snapshot branch: `archive/progress-20261118-CogPortal-care-ci-20260922` (HEAD plus the uncommitted work listed below)
- Last commits:
- 9dcacf3 2026-09-29 fix(ci): reject sweep text longer than the protocol allows
- 73b3b49 2026-09-29 fix(gallery): show the lone-chart state with a Language sweep
- aa06f62 2026-09-29 fix(ci): reject whitespace-only metric keys and labels
- b31ed75 2026-09-22 fix(ci): validate producer metric declarations before release
- 361463f 2026-09-15 Revert "fix(runs): ignore a sweep declaration the wire would refuse"
- e1aeaba 2026-09-15 fix(runs): ignore a sweep declaration the wire would refuse
- 0de64d2 2026-09-15 Merge remote-tracking branch 'origin/ci/runner-suite-imports' into fix/sweep-metric-and-lone-chart
- a8d76d4 2026-09-15 feat(runs): label a sweep with the metric it draws, and introduce a lone chart

The working tree was clean; nothing uncommitted was captured.

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-care-ci-20260922"
git -C "$HOME/Programming Projects/CogPortal-care-ci-20260922" checkout archive/progress-20261118-CogPortal-care-ci-20260922
```

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
