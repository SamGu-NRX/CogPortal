# Progress snapshot: CogPortal-gpt-w2-cp-hard (20261118)

The local checkout `~/Programming Projects/CogPortal-gpt-w2-cp-hard` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `gpt-burst/1022p-activity-csrf-header` at `5c78513dd5`
- Snapshot branch: `archive/progress-20261118` (HEAD plus the uncommitted work listed below)
- Last commits:
- 5c78513 2026-10-22 fix(portal): protect OAuth state navigations
- ac910bd 2026-10-22 fix(portal): require an Activity CSRF header
- d9185a8 2026-10-22 Merge remote-tracking branch 'origin/alpha' into gpt-burst/1022p-activity-csrf-header
- e7733b6 2026-10-22 Merge #141 (bound request bodies read before auth) into alpha
- f9c0373 2026-10-22 fix: preserve raw bytes before auth and signatures
- 2ff6488 2026-10-22 fix: bound unsigned webhook and auth bodies
- da138e2 2026-10-22 Merge #138 (Simulated label per run, B-53 copy) into alpha
- a5059bc 2026-10-22 Merge #133 (CLI messages) into alpha

The working tree was clean; nothing uncommitted was captured.

## What's left

Nothing recorded beyond the commits above.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-gpt-w2-cp-hard"
git -C "$HOME/Programming Projects/CogPortal-gpt-w2-cp-hard" checkout archive/progress-20261118
```

## Thread

No T3 thread was found for this checkout.
