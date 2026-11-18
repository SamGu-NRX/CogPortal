# Progress snapshot: CogPortal-public-results-20261003 (20261118)

The local checkout `~/Programming Projects/CogPortal-public-results-20261003` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `ux/public-results-20261003` at `e6b77e153c`
- Snapshot branch: `archive/progress-20261118-CogPortal-public-results-20261003` (HEAD plus the uncommitted work listed below)
- Last commits:
- e6b77e1 2026-10-04 fix(leaderboard): draw a curve point only where its published metric agrees
- 414044b 2026-10-04 fix(leaderboard): address PR92 review on disclosure, Overall footer and scorers
- dfc8885 2026-10-04 fix(leaderboard): name query variants in course words and state the scale
- 60384f1 2026-10-03 feat(leaderboard): read published results newest first, with their curves
- ae1d4d1 2026-10-03 docs(testerarmy): record the revised link test's runs at a966ca1
- a966ca1 2026-10-03 test(testerarmy): stop claiming the agent link step is keyboard-only
- d385fe5 2026-10-03 chore(e2e): include corrected CLI distribution guidance
- 3f44878 2026-10-03 docs(setup): correct the pinned CLI distribution note

The working tree was clean; nothing uncommitted was captured.

Git-ignored files that can't be rebuilt (.env files, local data) were copied to `~/MacSetup/worktree-leftovers-20261118/CogPortal-public-results-20261003` on the Mac. They are not on GitHub or Drive.

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-public-results-20261003"
git -C "$HOME/Programming Projects/CogPortal-public-results-20261003" checkout archive/progress-20261118-CogPortal-public-results-20261003
```

Then copy the kept ignored files back: `cp -R "$HOME/MacSetup/worktree-leftovers-20261118/CogPortal-public-results-20261003/." "$HOME/Programming Projects/CogPortal-public-results-20261003/"`, and reinstall dependencies.

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
