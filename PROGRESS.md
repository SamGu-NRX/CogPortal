# Progress snapshot: CogPortal-language-check-20261001 (20261118)

The local checkout `~/Programming Projects/CogPortal-language-check-20261001` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `fix/language-check-course-env-20261001` at `23db469cfb`
- Snapshot branch: `archive/progress-20261118-CogPortal-language-check-20261001` (HEAD plus the uncommitted work listed below)
- Last commits:
- 23db469 2026-10-01 fix(cogbench): name a repeated call by its argument objects, not their positions
- 8a3e76e 2026-10-01 fix(cogbench): skip only an exact repeat of a timed-out call, and stop a fit at its first hit
- d917b86 2026-10-01 fix(setup): install the CLI from 71e4767, with type-scoped timeout skips
- 71e4767 2026-10-01 fix(cogbench): keep one-item timeouts to the argument types they had
- 5a2ff78 2026-10-01 fix(setup): install the CLI from fb219f1, which keeps argument types apart
- fb219f1 2026-10-01 fix(cogbench): remember a one-item timeout with the argument types it had
- 050039b 2026-10-01 fix(dashboard): scope the same-commit sync advice to trained weights
- 82238e7 2026-10-01 fix(setup): install the CLI from f635514, with the tuned-call fix

The working tree was clean; nothing uncommitted was captured.

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-language-check-20261001"
git -C "$HOME/Programming Projects/CogPortal-language-check-20261001" checkout archive/progress-20261118-CogPortal-language-check-20261001
```

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
