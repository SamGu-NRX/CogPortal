# Progress snapshot: CogPortal-data-identity-20261002 (20261118)

The local checkout `~/Programming Projects/CogPortal-data-identity-20261002` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `fix/benchmark-data-identity-20261002` at `2f69bd1b99`
- Snapshot branch: `archive/progress-20261118-CogPortal-data-identity-20261002` (HEAD plus the uncommitted work listed below)
- Last commits:
- 2f69bd1 2026-10-02 test(portal): check Retry starts 0049's activity clock fresh beside the digest
- b28eb6a 2026-10-02 Merge integration edf4de3 into fix/benchmark-data-identity-20261002
- edf4de3 2026-10-02 docs(migrations): state what 0044 did without giving it a reason
- b214670 2026-10-02 Merge commit 'b19959c' into fix/overnight-membership-20261002
- f8358de 2026-10-02 fix(runs): judge a silent execution by its last accepted callback
- c81878b 2026-10-02 fix(runs): release the quota held by recognition-v1 runs after 0044
- b19959c 2026-10-02 fix(discord-bot): describe bench posts without promising one per run
- d068212 2026-10-02 fix(admin): tell a team whose runs failed from one that never ran

The working tree was clean; nothing uncommitted was captured.

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-data-identity-20261002"
git -C "$HOME/Programming Projects/CogPortal-data-identity-20261002" checkout archive/progress-20261118-CogPortal-data-identity-20261002
```

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
