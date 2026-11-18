# Progress snapshot: CogPortal-qa-video-20260930 (20261118)

The local checkout `~/Programming Projects/CogPortal-qa-video-20260930` was removed on 2026-11-18 to free disk space on Sam's Mac, after everything in it was pushed here. This file records where the work stood.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `test/beta-video-20260930` at `cbd8266810`
- Snapshot branch: `archive/progress-20261118-CogPortal-qa-video-20260930` (HEAD plus the uncommitted work listed below)
- Last commits:
- cbd8266 2026-10-01 fix(run-surfaces): deliver a late result even if its first publication fails
- 25d4bdc 2026-10-01 fix(run-console): show a silent local run as lost contact on the web
- fecb687 2026-10-01 Merge commit 'ed2b194819e85e188a74855cb6e38dc900df587f' into fix/beta-live-history-20261001
- 3a08b61 2026-10-01 fix(discord-bot): mark a silent live run as lost contact in /cog
- 1b00e6d 2026-10-01 fix(team): store only history that GitHub actually returned
- 683d7ea 2026-10-01 fix(local-runs): show a silent live run as lost contact, not running
- 45fd963 2026-10-01 fix(team): stop one caller's missing token from failing team history
- ed2b194 2026-10-01 Merge feat/human-centered-ui-20260930 (2ff32fa) into beta

The working tree was clean; nothing uncommitted was captured.

Files over GitHub's 100 MB limit, copied to Google Drive (`gdrive-own`) and checked by MD5:

- `outputs/ (2892 untracked files, as one tar)` (376 MiB) -> `gdrive-own:Mac offload 2026-11-18/repo-large-files/CogPortal-qa-video-20260930/outputs-untracked.tar`

Git-ignored files that can't be rebuilt (.env files, local data) were copied to `~/MacSetup/worktree-leftovers-20261118/CogPortal-qa-video-20260930` on the Mac. They are not on GitHub or Drive.

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/Programming Projects/CogPortal-qa-video-20260930"
git -C "$HOME/Programming Projects/CogPortal-qa-video-20260930" checkout archive/progress-20261118-CogPortal-qa-video-20260930
```

Then copy the kept ignored files back: `cp -R "$HOME/MacSetup/worktree-leftovers-20261118/CogPortal-qa-video-20260930/." "$HOME/Programming Projects/CogPortal-qa-video-20260930/"`, and reinstall dependencies.

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
