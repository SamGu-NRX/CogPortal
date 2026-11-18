# Progress snapshot: CogPortal (20261118)

Snapshot of the local checkout `~/BWSI/2026/CogPortal`, taken on 2026-11-18 before a disk cleanup. The checkout itself was kept.

## What it is

CogWorks benchmark platform: This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.



## State

- Checkout branch: `fix/product-description-triage` at `c32d82575b`
- Snapshot branch: `archive/wip-20261118-CogPortal` (HEAD plus the uncommitted work listed below)
- Last commits:
- c32d825 2026-09-05 fix: six findings from the independent review of the first-run rewrite
- 01aa876 2026-09-05 ci: the week jobs check a repository that has a submission, and Windows skips the alarm
- 5059e1f 2026-09-04 docs: the CLI install line that works today
- f4c805f 2026-09-04 fix: the primary metric carries four decimals from both scorers
- d482875 2026-09-04 fix: a run still queued after ten minutes is failed, not after an hour
- b95a23c 2026-09-04 fix: two development accounts with one display name no longer share a React key
- 5a74e74 2026-09-04 fix: the CLI names the install command, keeps its sentences whole, and reads plainly
- e21e2f3 2026-09-04 fix: the per-call clock in the pipeline is skipped where SIGALRM is absent

Uncommitted work captured in this branch (32 paths):

- `apps/discord-bot/test/commands.test.ts`
- `apps/portal/src/routes/LeaderboardPage.tsx`
- `apps/portal/src/routes/TeamPage.tsx`
- `apps/portal/test/process-signals.test.ts`
- `apps/portal/worker/auth/session.ts`
- `apps/portal/worker/db/schema.ts`
- `apps/portal/worker/github/client.ts`
- `apps/portal/worker/github/commits.ts`
- `apps/portal/worker/http/errors.ts`
- `apps/portal/worker/http/serializers.ts`
- `apps/portal/worker/routes/admin.ts`
- `apps/portal/worker/routes/github.ts`
- `apps/portal/worker/routes/team-membership.ts`
- `apps/portal/worker/routes/team.ts`
- `apps/portal/worker/services/leaderboard.ts`
- `apps/portal/worker/services/process-signals.ts`
- `docs/product-description/portal/admin.md`
- `docs/product-description/portal/connect-a-repository.md`
- `docs/product-description/portal/sign-in.md`
- `docs/product-description/portal/start-a-practice-run.md`
- `docs/product-description/portal/the-leaderboard.md`
- `docs/product-description/terminal/check.md`
- `docs/product-description/terminal/report.md`
- `docs/product-description/terminal/status.md`
- `docs/product-description/terminal/sync.md`
- `packages/contracts/src/schema.ts`
- `apps/portal/migrations/0034_team_provenance.sql`
- `apps/portal/scripts/seed-staging-archive.sql`
- `apps/portal/test/leaderboard-archive.test.ts`
- `apps/runner-modal/uv.lock`
- `docs/demo/elevator-pitch.md`
- `t3.json`

Left out of git on purpose (secret-looking; copied to the Mac's local leftovers folder only):

- `apps/portal/test/github-connect.test.ts` (content generic)

## What's left

From the lead thread's wind-down summary (10-23): #149, #150 and #154 land together in that order; device-link fixes pair #134+#153, #143+#155, #135+#152 and need an independent review; Sam decides whether to keep #113 and how the Staff Desk (#114, #144) shows students to TAs; #152 (rate limits) is unmerged. Release steps: acceptance/cogportal.md. On 11-18 the overnight thread said no CogPortal-* worktree needed to stay on disk; .dev.vars files with real secrets were copied to the local leftovers folder only.

## How to resume

```sh
git clone https://github.com/SamGu-NRX/CogPortal.git "$HOME/BWSI/2026/CogPortal"
git -C "$HOME/BWSI/2026/CogPortal" checkout archive/wip-20261118-CogPortal
```

## Thread

Last T3 thread: [Overnight: integrate and prove the hosted product](t3-thread://v2/35dfd9c3-af2b-49cb-ad17-81b58f6d497f/f08b3598-f06f-41a1-a008-c6b104f156ad) (idle, updated 2026-10-19).
