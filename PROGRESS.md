# Progress snapshot: CogPortal-sdk-interrupt-20260930 (20261118)

The local checkout `~/Programming Projects/CogPortal-sdk-interrupt-20260930` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `fix/sdk-interrupt-20260930` at `431f17f4a4`
- Snapshot branch: `archive/progress-20261118-CogPortal-sdk-interrupt-20260930` (HEAD plus the uncommitted work listed below)
- Last commits:
- 431f17f 2026-09-30 test(cogbench): give the interrupt test its own SIGINT handler
- 7f1944e 2026-09-30 fix(portal): close an open modal when the restore gate conceals the page
- d098217 2026-09-30 fix(portal): stop the admin-removal refusal promising settings access
- 44c3ca6 2026-09-30 fix(portal): close three gaps the restore gate left
- 5f538b2 2026-09-30 docs: record the restore gate in the back/forward-cache triage entry
- f8a1937 2026-09-30 Merge fix/restore-session-gate-20260930 (withhold account content until a returning page rereads the session) into the integration candidate
- 9dc76af 2026-09-30 fix(portal): withhold account content until a returning page rereads the session
- 0d2ba7d 2026-09-30 docs(cogbench): say which command a synced report came from and that run --live sends one

The working tree was clean; nothing uncommitted was captured.

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-sdk-interrupt-20260930"
git -C "$HOME/Programming Projects/CogPortal-sdk-interrupt-20260930" checkout archive/progress-20261118-CogPortal-sdk-interrupt-20260930
```

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
