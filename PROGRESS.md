# Progress snapshot: CogPortal-codex-artifact-20261002 (20261118)

The local checkout `~/Programming Projects/CogPortal-codex-artifact-20261002` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `codex/prepared-artifact-audit-20261002` at `93dfa5e9b6`
- Snapshot branch: `archive/wip-20261118-CogPortal-codex-artifact-20261002` (HEAD plus the uncommitted work listed below)
- Last commits:
- 93dfa5e 2026-10-02 Merge UI c4c48cb (review media for the focus and findings batch)
- 860fb9b 2026-10-02 Merge systems 3903291 (Retry weights record and Discord result author)
- c4c48cb 2026-10-02 docs(review): add focus and findings evidence for the UI batch
- 3903291 2026-10-02 fix(discord): stop naming the person beside a run's result
- 505ce25 2026-10-02 fix(runs): keep the weights record when a Retry reuses its saved artifact
- 7240154 2026-10-02 docs(product-description): state when Retry appears and the older-scorer refusal
- 11cb2b7 2026-10-02 Merge UI 3689ac5 (open a finished run's findings from its console)
- 3689ac5 2026-10-02 fix(portal): open a finished run's findings from its console

Uncommitted work captured in this branch (3 paths):

- `apps/portal/test/runner-event-durability.test.ts`
- `apps/runner-modal/tests/test_artifact_provenance_official.py`
- `apps/runner-modal/tests/test_artifact_provenance_resources.py`

Left out of git on purpose (secret-looking; copied to the Mac's local leftovers folder only):

- `apps/portal/test/run-actions.test.ts` (content generic)

Git-ignored files that can't be rebuilt (.env files, local data) were copied to `~/MacSetup/worktree-leftovers-20261118/CogPortal-codex-artifact-20261002` on the Mac. They are not on GitHub or Drive.

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-codex-artifact-20261002"
git -C "$HOME/Programming Projects/CogPortal-codex-artifact-20261002" checkout archive/wip-20261118-CogPortal-codex-artifact-20261002
```

Then copy the kept ignored files back: `cp -R "$HOME/MacSetup/worktree-leftovers-20261118/CogPortal-codex-artifact-20261002/." "$HOME/Programming Projects/CogPortal-codex-artifact-20261002/"`, and reinstall dependencies.

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
