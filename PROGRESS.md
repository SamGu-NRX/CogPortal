# Progress snapshot: CogPortal-gpt-w2-cp-portal (20261118)

The local checkout `~/Programming Projects/CogPortal-gpt-w2-cp-portal` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `lead-alpha-147` at `9a60d28696`
- Snapshot branch: `archive/progress-20261118-CogPortal-gpt-w2-cp-portal` (HEAD plus the uncommitted work listed below)
- Last commits:
- 9a60d286 2026-10-22 Merge #147 (Discord /leaderboard marks the student's team; exact quota copy) into alpha
- d06c10ad 2026-10-22 fix(portal): cover rerun quota and stable board ties
- 4dc13d08 2026-10-22 fix(discord): choose board from newest run and state quota rules
- 6a37d221 2026-10-22 Merge #146 (Activity CSRF: required Activity header) into alpha
- 5c78513d 2026-10-22 fix(portal): protect OAuth state navigations
- ac910bd4 2026-10-22 fix(portal): require an Activity CSRF header
- a9860030 2026-10-22 Merge origin/alpha and preserve both Discord leaderboard markers
- d9185a86 2026-10-22 Merge remote-tracking branch 'origin/alpha' into gpt-burst/1022p-activity-csrf-header

The working tree was clean; nothing uncommitted was captured.

## What's left

Nothing recorded beyond the commits above.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-gpt-w2-cp-portal"
git -C "$HOME/Programming Projects/CogPortal-gpt-w2-cp-portal" checkout archive/progress-20261118-CogPortal-gpt-w2-cp-portal
```

## Thread

No T3 thread was found for this checkout.
