# Merging the release stacks, September 30 2026

Sam should merge the benchmark chains first, then the CogPortal order below.
The PR map and checks were read on September 30; the JSON files retain the
observation evidence. #2, #12 and #52 moved later that day; their heads and
checks were read again, and the CogPortal suffix was replayed with them. This
audit pushed nothing. The candidate `integration/demo-acceptance-20260930`
ends at `7f1944e`. #2 and #52 now carry most of its repairs; the rest have
proposed homes under "Repair ownership before the final pin" and are not
proven by the dry run until their PRs are replayed.

The earlier proof replayed main `5c2aa40` through the original order. The
current proof reuses its unchanged prefix through #22 and replays everything
after it. It proves merge/test behavior under the stated resolutions, not
browser, hosted, Discord or production acceptance. Those still need the exact
final main tree.

Before each merge, read the full head and checks again. A changed head
invalidates its recorded review and conflict evidence.

```sh
gh pr list -R SamGu-NRX/CogPortal --state open --limit 100 \
  --json number,headRefOid,baseRefName --jq '.[] | "\(.number) \(.headRefOid) \(.baseRefName)"'
gh pr checks N -R SamGu-NRX/CogPortal --json name,state,bucket,link
gh pr checks N -R SamGu-NRX/CogPortal --required --json name,state,bucket,link
```

## Decisions and merge stops

- #2 and #11 no longer rename applied migrations. Their current heads hold
  `0039_setup_check_source.sql` and `0040_run_repository_name.sql`; no
  ledger rename or compatibility stub is needed. Reuse the fresh-DB,
  hosted-ledger-copy, base-upgrade and whole-stack proof at
  `/Users/samgu/Documents/Codex/2026-09-09/goal-manager-dynamic-users-samgu-codex/work/implementation/pr-migration-names-20260930/`.
  `proof.log` names these exact heads, finishes with `ALL EXPECTATIONS MET`,
  and includes the old heads as failing duplicate-column controls.
- #47's saved-Vision fake fix is on #50 `c4901e58`, not #47. Land #50
  immediately after #47. #50 must also carry integration-only `3d4f43f`
  when its owner merges main into it after #19. The old scorer test looks
  for a class that #50 moved out of `modal_app.py`; three tests fail before
  the repair and the runner suite passes afterward, apart from three skips.
  #50's own CI lacks the #19 test, so it does not cover this interaction.
- The three copy and layout findings are closed on the current heads.
  #2's `a9eab45` lets the completion panel say "verified" only when the
  portal observed every step. #52's `6648997` says each weight file "is
  uploaded with it or is already in your commit", which holds under #52's own
  SDK (committed bytes skipped) and under step 36's #48, whose `sync` uploads
  every retained receipt (`cli.py:1265-1305` at `d0b6527`). #52's `0741b3d`
  only comments the metadata row; the owner checked the `-ml-8` row in a
  browser at 390, 768 and 1280px and it does not clip.
- #2's final head is `62f1927`: `b0a29af` plus `6880b0c` (a returning page
  that finds another account reloads the document) and `62f1927` (focus
  goes to the account menu after a header retry succeeds). Together they
  touch `RestoreGate.tsx`, `restored-document.test.ts` and
  `docs/product-description/bug-triage.md`. The replay with this head has
  the same conflicts at every step, and each step tree from 29 on differs
  from the `b0a29af` proof only in those three files. None of the three is
  in a later step's conflict list or reapplied patches. A further #2 change
  confined to them reopens only step 29's checks; one touching any other
  file, or adding a conflict, reopens steps 29-36 (rerun the replay with
  `DRY_SET=<new set> python3 replay-b.py <40-char #2 SHA>`).
- `leaderboard-scorer-version.test.ts` fails 3 of 10 from step 14 onward:
  #22's source check refuses the fixture's `repositoryId: 123`. It passes at
  step 13, on the candidate, and at step 14 with `85b7fd4`'s one fixture
  line, so that line goes into #22's step-14 merge resolution (name
  `85b7fd4` in the merge message). The test breaks at the merge that adds
  the check, and main's CI would otherwise stay red through every later
  step and trip the CI stop below.
- Root assigns writers for the seed/guide/pin review stack at step 37.
  `d14a51e`'s four guides stay in the release.
- #41/#25/#29 retain their current re-authored commits under merge commits.
  Older copies are on `backup/pre-reauthor-pr25` and
  `backup/pre-reauthor-pr29`; Sam's authorship decision remains open.
- #11's backfill proves repository identity by matching IDs, not historical
  spelling after a rename. The author explicitly accepts current spelling;
  Macroscope disputed that choice. No new data-policy decision is made here.

Excluded, not closed: CogPortal #26, #36, #40, #42 and #49. #42 changes
hosted configuration as well as guides; porting the guides is not merging
#42. Audio #1, Vision #3/#4 and Language #3 remain sibling changes outside
the pinned chains. Previous #49 CI failure was not refreshed in this audit.

## Rules for every step

- **Merge commits only.** No squash, no rebase.
  Reasons, from the actual graphs:
  - The benchmark pins are exact SHAs. The replay in each benchmark clone
    kept every pin that CogPortal `main`, the candidate or any open PR
    names reachable from benchmark `main` under merge commits. Squash lost
    them (Audio `4e516f3` and `ad05587`), and Vision and Language squashes
    stopped at conflicts (Vision #1: `discovered.py`, `roles.py`,
    `test_discovered_repository_results.py`; Language #2: `roles.py`).
  - Most CogPortal PRs are stacked on another branch. A
    squashed lower PR leaves every PR above it carrying the original
    commits, which then conflict with their own squashed copy and need a
    rebase and force-push for each dependent.
  - The recorded conflict resolutions depend on these exact heads. Merge
    commits keep the heads available for comparison.
  - The final pin PR pins the SDK by CogPortal commit. Only a merge commit
    keeps that commit on `main`.
- **Retarget before merging.** `delete_branch_on_merge` is off in all four
  repositories, so GitHub will not move a dependent PR's base when its base
  merges. Merging without retargeting lands the PR in a dead feature
  branch, not `main`. The one deliberate exception is the SDK line at
  step 36.
- **Pin the head, in full.** `--match-head-commit` needs the 40-character
  SHA; GitHub rejects an abbreviation. Full SHAs for every step are in the
  last section. A PR whose head changes (a conflict resolution, a repair
  or a step-36 promotion) gets its new full SHA
  read and its CI checked before it merges.
- Every command names its repository:

  ```sh
  R=SamGu-NRX/CogPortal   # or the benchmark repository
  gh pr edit N -R "$R" --base main
  gh pr view N -R "$R" --json headRefOid,baseRefName,mergeStateStatus
  gh pr merge N -R "$R" --merge --match-head-commit <40-char SHA>
  ```
- **Do not delete branches.** Pinned benchmark SHAs, #48's SDK commits and
  the candidate branch must stay fetchable until the pin PR lands.
- **A conflict step** means the PR's owner merges `main` into the PR branch
  with an ordinary merge commit, resolves, pushes, and CI passes on the new
  head before Sam merges. Nothing is force-pushed.

Stop the sequence if a head moved, if `mergeStateStatus` is `DIRTY` on a step
listed as clean, if CI on a resolved head fails, or at the explicit stops
below.

## Current review coverage and finding dispositions

For #2/#11/#12/#50/#51/#52, all listed execution CI jobs pass at the
captured heads. Macroscope is skipped on every one, so none is described as
all-checks-green. `gh pr checks --required` reports no required checks on
these requests, which does not establish main's protection
policy after retargeting. #51's CodeRabbit pending check completed during
this audit. A successful check label alone does not prove a review happened.

| PR | Current-head coverage | Findings and limits |
| --- | --- | --- |
| #2 `62f19276` | Execution CI passes; Greptile and CodeRabbit checks pass; Macroscope skipped. Which head their reviews cover was not read. | Restored migration name unchanged. Completion-copy finding fixed by `a9eab45`. Cache finding fixed on the PR by `f9342b0`/`4368fcb`. Restore gate, public-page retry and offline/cold-load recovery were not reviewed in this audit; the replay runs their tests. Reset-token replay is an explicitly accepted rehearsal behavior, not newly settled here. |
| #11 `6f70afd2` | Greptile summary names this head, 5/5, no new findings. CodeRabbit marker is `81971b97`; Macroscope skipped. | Rename defect fixed, despite stale replies claiming the files were never applied remotely. Historical-spelling backfill remains the author-accepted policy dispute above. Missing repo-ID dashboard behavior was explicitly accepted by the author; reconnect records the ID. |
| #50 `c4901e58` | Greptile summary names this head, 5/5. CodeRabbit marker is `a25a62e9`; Macroscope skipped. | Saved-Vision fake now takes `text=True`; verified by the suite. Scorer interaction is reproducible and repaired only locally by `3d4f43f`; extend #50. Earlier outside-diff doc-citation note is separate documentation work, not proof of a runner defect. |
| #51 `5ffc0d16` | Greptile summary names this head, 5/5. CodeRabbit completed with this head in its coverage marker and no actionable comments. Macroscope skipped. | TA-coverage finding is stale: the new test includes assigned, unassigned, other-cohort and empty-assignment cases. The merged `admin-members.test.ts` passes and retains this test. |
| #12 `a7ecaab2` | Execution CI passes. Greptile reviewed this head, nothing actionable. CodeRabbit reviewed `c91cfaf..a7ecaab`, nothing actionable, plus one outside-diff note, disposed of in the next column. Macroscope and Aikido have no coverage of this head. Two older Aikido threads (local self-report `sys.path`; silent `pyvenv.cfg` skip) stay open by design with accepted dispositions. | `cbd027b` is test-only. `66c6def`/`a7ecaab` survive step 36's promotion and main merge; the SDK suite passes on the replayed tree. CodeRabbit's note, that on #12 alone `retain_input` writes a copy `sync` never uses, is fixed in the combined tree by `a63530b`: on the final replay tree `resolve.py:1608` calls `storage.retain_input(project.original, original, source_root=repository)`, and `cli.py:415` passes `submission.weights_captured` through `execute` into the report whose receipts `sync` uploads (`cli.py:1265`). `test_retained_scoring_input` 38, `test_weights_sync` 12, `test_cli_submission` 6 and `test_lifecycle` 146 pass there on Python 3.8. |
| #52 `8557cb64` | Execution CI passes. Greptile reviewed this head (review 5369711731), 5/5, no bugs, both threads resolved. CodeRabbit skipped because the base is nondefault, despite its success label. Macroscope skipped for credit; Codex did not run (quota). | Weight-copy and metadata-clip findings closed (see merge stops). `8557cb6` keeps "Run complete" out of a failed run's folded summary; `run-console.test.ts` passes on the replayed tree. |

Fresh JSON includes complete conversation comments and paginated REST inline
comments under `/tmp/mergeplan-dryrun-refresh-20260930-evidence/`, using
`prN-final-view.json`, `prN-final-checks.json`, `prN-required.json`, and
`prN-inline.json`. REST does not expose thread-resolution state; this audit
makes no new claim that all threads are resolved. For the moved heads (#2,
#12, #52) and SDK-line PRs #32, #48 and #5, `prN-view.json` and
`prN-checks.json` under `/tmp/mergeplan-dry-20260930b-evidence/` hold the
later read; comments were not re-read. All six report `CLEAN`. #2's final
head was read again into `/tmp/mergeplan-dry-20260930c-evidence/`, also
`CLEAN`. On `62f19276` no bot has reviewed yet (latest Greptile is on
`b0a29af`; its P1 on the mutation wait is resolved and `6880b0c` removes
that wait). Two older #2 threads stay unresolved for #2's owner: Aikido on
`worker/routes/setup.ts` and CodeRabbit on `lib/queries.ts` (answered
"fixed in f9342b0"). No comments or reviews were posted, and no continuing
watch is active.

For unchanged PRs, reuse the earlier review audit rather than calling it
fresh approval. It reported no current-head bot completion for #7/#9/#10/
#20/#32; Vision #5 was draft-skipped and Vision #6's Greptile review
covered an older head. Vision #1's `plugins.py:427` finding is fixed by #6;
its `roles.py:1075` docstring finding remains. The earlier portal thread
counts are not current-head readiness evidence after these pushes.

## Order

### 1. Benchmarks first

All clean as merge commits. Each stack is linear, so either bottom-up
(retarget each to `main`) or merging only the top PR carries the same
commits; bottom-up records every PR as merged.

| Repo | Order (head) |
| --- | --- |
| Audio | #2 `4e516f39` |
| Vision | #5 `c177cf23` (draft, mark ready first), #1 `11a8baf6`, #2 `b9055031`, #6 `a3dd948d` |
| Language | #1 `1004766b`, #2 `cc67edbc`, #4 `6dc63fe8`, #5 `94c7e64f` |

Vision `main` equals upstream `iReynaldo/ComputerVisionBenchmark` `main`
(`79bc725`, 0 ahead, 0 behind). Language #5 at `94c7e64`: tests on 3.8 and
3.11 pass, CodeRabbit completed on this head, Greptile's run is labelled
"Base review", Macroscope skipped (credit exhausted), no unresolved threads.

### 2. CogPortal

"Reference" names the candidate merge whose `git show --remerge-diff`
shows how that file was resolved. The candidate is the end state, so at an
early step its version of a file can include content from later PRs; use it
as a guide to intent, not as a file to copy. "Newer than candidate" lists
commits on the PR or `main` that the candidate never had, which the
resolution must keep.

Steps 1 through 14 reuse the earlier replay. The replayed suffix begins at
step 14's detached merge commit `d6d25501b19b412620fecb5f7f90c77c521526b1`.
It inserts #51 after #45, #52 after #46, and #50 after #47. Existing
resolution blobs come from `alternative-replay.json`, including #25's
`8ed4ef5` resolution. Counts below reflect this suffix, not the earlier
candidate-copy replay. At every step the replayed tree differs from the
earlier suffix proof only in files the new #52, #2 and #12 commits touch.
The saved #47 resolution retains the explanation
specified below but omits #47's supporting comment. Add that comment on the
owner's resolved head; the saved proof does not establish an identical final
tree. A different behavioral resolution requires another replay.

| # | PR | Head | Replay result | Resolution notes |
| --- | --- | --- | --- | --- |
| 1 | #1 | `9c56d93b` | clean | |
| 2 | #8 | `a4f21e49` | clean | |
| 3 | #13 | `f26c3bdd` | clean | |
| 4 | #15 | `12df96f2` | clean | |
| 5 | #16 | `0ac41e64` | clean | |
| 6 | #23 | `d595e5df` | clean | `d595e5d` (docs) is newer than candidate |
| 7 | #33 | `2a4275cd` | clean | |
| 8 | #34 | `19f26e5f` | clean | |
| 9 | #37 | `4ed02ed2` | clean | |
| 10 | #30 | `baab265b` | clean | its install table is superseded at step 37 |
| 11 | #19 | `c701d341` | 2 files | `prepared_environment.py`, `test_prepared_environment.py`; reference `b46122b` |
| 12 | #24 | `e264e1da` | clean | |
| 13 | #27 | `7f1e9bc5` | clean | |
| 14 | #22 | `f0cb021c` | 3 files | `setup-progress.ts` (`c7b732f`), `run-actions.ts` (`b46122b`), `runner.ts` (`c0df257`). Also apply `85b7fd4`'s fixture line in the resolution; without it 3 `leaderboard-scorer-version.test.ts` cases fail |
| 15 | #45 | `6d95bda4` | clean | |
| 15a | #51 | `5ffc0d16` | clean | admin summaries and TA-scope regression; retarget to main after #45 |
| 16 | #46 | `b0bc4612` | clean | |
| 16a | #52 | `8557cb64` | clean | browser repairs; retarget after #46. Replayed tree passes `code-highlighting.test.ts` and `run-console.test.ts` (29/29) |
| 17 | #41 | `2fa6fe98` | clean | |
| 18 | #25 | `727f9879` | 9 files | `benchmarks/week3`, `cli.py`, `client.py`, `models.py`, `resolve.py`, three SDK tests, `validate_week3_submodule.py`; reference `8ed4ef5`, same file set |
| 19 | #29 | `73ffbe08` | clean | clean after using `8ed4ef5` at #25 |
| 20 | #44 | `87cc947a` | clean | |
| 21 | #4 | `a8c56c3a` | 2 files | `ci.yml` (`1f3e067`), `test_week3_payload.py` (candidate file, last touched `97821a0`) |
| 22 | #3 | `0a82fc83` | clean | |
| 23 | #38 | `b74313af` | clean | |
| 24 | #28 | `194ef7bc` | 1 file | `protocol.ts`; reference `ebb3d79` |
| 25 | #31 | `9dcacf3b` | 2 files | `GalleryPage.tsx` (`3548d73`), `modal_app.py` (`72386e0`); keep `73b3b49`'s Language lone-chart fixture, newer than candidate |
| 26 | #10 | `98eecac9` | 3 files | `activity-main.tsx`, `activity-auth.test.ts`, `GalleryPage.tsx`; reference `c3cdad3`; keep `73b3b49` again |
| 27 | #17 | `692ab15e` | 1 file | `setup-progress.ts`, keep `main`'s. **Also** rename `linkCommand` to `deviceLinkCommand` in `ConnectionsPage.tsx` and `connections-link-command.test.ts` (as `c3cdad3` did). Git reports no conflict there; the replayed tree fails `pnpm check` with TS2305 at `ConnectionsPage.tsx:9` |
| 28 | #47 | `645b9e8e` | 1 file | `failures.ts`: retain #47's `adapter_missing.explanation`, "This run did not reach scoring. The available details are below.", and its supporting comment explaining why attribution is uncertain. Preserve main's other strings; taking #47's whole file reverts six newer strings |
| 28a | #50 | `c4901e58` | 1 file | `modal_app.py`: remove the two extracted blocks, as `c85ce9c` did; keep other automatic merges. Add `3d4f43f` to #50 after merging main into it. Stop until that new head passes tests and fresh review |
| 29 | #2 | `62f19276` | 1 file | `pnpm-lock.yaml`, keep `main`'s. `4c95eef` adds `happy-dom` 20.14.3, which main already has from #22 (`df9db6f`) at the same specifier; the locks differ only in the transitive `@types/ws` patch. `RunConsole.tsx`, `UserMenu.tsx` and `SetupPage.tsx` merge automatically with #52's changes. Replayed tree passes `restored-document`, `setup-completion` and `setup-state-account-switch` tests (28/28) |
| 30 | #11 | `6f70afd2` | 1 file | `serializers.ts`, keep main's plus `5bdedf9`; original migration name restored |
| 31 | #14 | `d50be7b8` | 7 files | 6 take main's side; `run-source.test.ts` combines. Newer than candidate: `594fbb0`, `3078585`, `2e907c3`, `c2ccadf`, `5bdedf9`, `26aa861`; keep their changes |
| 32 | #18 | `9c651d0d` | 1 file | `CopyBlock.tsx`, `main`'s side plus `f0b298a` |
| 33 | #20 | `75ec3cbb` | 4 files | two tests take `main`'s side; `credit-and-quota.md`, `scoring-and-refusals.md` combine with `addfc17` |
| 34 | #21 | `cf4e3a48` | 1 file | `CodeContent.tsx`: #52's `tokenizeTimeLimit: 0` and #21's `.catch` that uncaches a failed load sit on adjacent lines. Keep both; the result equals candidate `7f1944e`'s file. `code-highlighting.test.ts` passes (15/15) |
| 35 | #43 | `cdd9adce` | clean | |
| 36 | SDK line | #48 `d0b65275` via #32 `5042fcbf`, #12 `a7ecaab2`, #9 `768988a6`, #7 `2c3ce222`, #6 `a250b28b`, #5 `738ae353` | see below | #32 into #12's branch is now a real merge, clean; then one conflict resolution (same 56 paths) for the whole line |
| 37 | release preparation and pin PR | not opened | not replayed | seed and guide review stack, then final pins; see below |

**Step 36.** This step does not retarget. Merge top down into the base
branches; each promotion gives the receiving PR a new head (read it, wait
for CI, then merge with that SHA): #48 into
`fix/resolver-refusal-names-the-week`, then #32 into
`fix/cogbench-process-boundary`, #12 into `feat/cogbench-terminal`, #9 into
`feat/cogbench-bind-and-report`, #7 into `feat/cogbench-repository-read`,
#6 into `feat/cogbench-call-forms`. Every step is a fast-forwardable merge
except #32 into #12's branch: #12 moved to `a7ecaab` after #32 was built on
`c91cfaf`, so that one is a real three-way merge. It is clean (GitHub
reports #32 `CLEAN`), keeps all of #12's `cbd027b`/`66c6def`/`a7ecaab`
hunks, and the merged tip passes `test_resolve` (128), `test_discover` (181,
1 skipped) and `test_fresh_interpreter` (24) on Python 3.8. Then retarget #5
to `main`. Its merge from main conflicts in the same 56 files as before,
because this line carries an older copy of the portal and SDK than
Foundation:
- Reuse the per-path resolutions recorded for #48 in
  `/tmp/mergeplan-20260930/audit/alternative-replay.json`, whose conflict
  list has 56 paths. The older 31/7/11 split described a different replay
  and no longer applies. Review every resolved diff before using it.
- Keep Audio `4e516f3`, Vision `a3dd948` and Language `94c7e64` consistent
  with their validators. The reference blobs already contain some final-pin
  install advice, so this replay is not an exact pre-pin release tree.
- Keep main's restored migration names and source comment. Preserve #51's
  TA tests and #52's browser changes. The reused `SetupPage.tsx` blob
  predates three commits; reapply, in order, that file's hunks from #52's
  `82ab6ea` (device-link paragraph) and `6648997` (weight copy), then #2's
  `a9eab45` (completion copy).
- The reused blobs for `resolve.py`, `discover.py`, `test_resolve.py`,
  `test_discover.py` and `test_fresh_interpreter.py` predate #12's new
  commits; reapply `git diff c91cfaf a7ecaab` for each. `test_resolve.py`
  needs a three-way apply because #48 added `Fixtures` to the import block
  the patch uses as context. `_namespace.py` merges automatically.
- Delete `apps/portal/test/setup-route.test.ts`. It arrives without a
  conflict, tests the SDK line's older setup route, and previously failed
  three tests on the merged tree. The candidate does not have it.

Merging the six SDK PRs one at a time into `main` instead cost six conflict
steps (66 file conflicts) in the replay.

**Step 37, release preparation followed by the final pin PR.** Assemble
these from main after step 36 and the repair groups below. Do not merge an
integration branch into a PR, which would import the entire candidate.
Use a small review stack, each retargeted to main after its predecessor
merges, so the final pin PR carries the seed and guide work without asking
one reviewer to inspect unrelated patches together.

1. Seed PR based on main. Port `4bd64cb` with its migration/seed tests and
   deployment/security documentation. Keep `0002_seed.sql`'s filename;
   existing hosted ledgers must not rerun it. Run `local-seed.test.ts`,
   `leaderboard-scorer-version.test.ts`, and
   `week2-recognition-scorer-v2.test.ts`; exercise a fresh local database
   and a copy of the recorded hosted ledger. Never apply this proof remotely.
   `85b7fd4`'s fixture line is already on main from step 14.
2. Guide PR based on the seed PR branch. Port `b79dadd` and `13dc0d1`
   together, using `5985556` as the rehearsal source. Carry `d14a51e`'s four
   guides. Include the guide corrections from
   `1d05873` only for the corresponding documentation files, not its
   ancestry or configuration files. Rehearse the documented local commands.
3. Final pin PR based on the guide PR branch, then retarget to main after
   both lower PRs merge. Use two commits and a merge commit.
   - Commit 1 pins Audio `4e516f39ffbeefe579e093260b2865eb354c17a7`,
     Vision `a3dd948d0c108fabf070b4f159acdecd4d6c3897`, and Language
     `94c7e64f7e3bf5193be1805b4258f017d044a088`, with matching
     `scripts/validate_week*_submodule.py`. Update SDK install advice in
     `plugins.py` and `test_plugins.py`; #48 still says Vision `c177cf23`
     and Language `b166f5c`. Update `benchmark-packages.ts` and its tests,
     `check.md`, `platform.md` and `timeouts-and-limits.md`. References
     are `f20f6ba`, `473dd0b`, `3bb74b7`, `5d6ae08`, `a13c667`, `265d40a`.
     `85b7fd4`'s fixture line lands at step 14.
   - Commit 2 sets `COGBENCH_SOURCE` to commit 1's full SHA. Repeat the
     release report's HTTPS install against that SHA before merging.
   - Do not pin candidate commit `40d31a2`; it is not a published main
     commit. Keep both the benchmark pins and SDK source SHA reachable
     through merge commits.

No new seed, guide, repair or pin PR was opened in this audit. Owners: root
assigns. Their final heads and checks must be added to this plan when their
owners supply them.
## Repair ownership before the final pin

Port patches, not integration ancestry. Each new head needs the owning
reviewer's checks again; the suggestions below do not authorize a push.

| Repair | Reviewable home and base | Why this grouping |
| --- | --- | --- |
| `3d4f43f` | Extend #50, branch `refactor/prediction-validation-20260930`, after its owner merges the then-current main containing #19. | Exception extraction and its cross-stack guard test belong in one runner review. Do not open a one-line guard PR against the whole candidate. |
| `ae1bb35` plus the `queries.ts` hunk of `8ce5e1b` | On #2 at `62f1927` as `f9342b0` and `4368fcb`. | Account/team identity changes the setup evidence and signed-command cache introduced by #2. The comment trim went with that fix. |
| `b2c526e` plus the `CodeContent.tsx` hunk of `8ce5e1b` | On #52 at `8557cb6` as `62c966d`. | Highlighting under CPU load belongs with the browser repair review. Step 34 now combines it with #21's `CodeContent.tsx` change. |
| `13dc0d1` | Step 37 guide PR, based on the seed PR branch, alongside `b79dadd` and the guide-only corrections from `1d05873`. | The rehearsal correction needs the guides it corrects; this is a documentation review, not a separate one-line PR. |

### Repairs that landed on the candidate after `8ce5e1b`

Candidate `integration/demo-acceptance-20260930` at `7f1944e` carries
these. The SHAs are candidate commits; port the named source commits and the
listed follow-ups, not the merge commits. The first two rows are now on #2
and #52; the rest are not on GitHub. The last three rows are local commits
on `fix/report-accessibility-20260930`, built on `7f1944e`.

| Candidate commits | Reviewable home and base | Why this grouping |
| --- | --- | --- |
| Restore gate `9dc76af` (merged as `f8a1937`), `44c3ca6`, `7f1944e`, docs `5f538b2` | On #2 at `62f1927` as `baed027`, `538895b`, `ebe0542`, docs `f7d0e34`, with the `happy-dom` dev dependency `4c95eef`. | Both repair the same boundary: which account the setup page's signed commands belong to. `538895b` carries the `LeaderboardPage.tsx` "you" badge change. |
| `cb1a7fc` failed-run console fold | On #52 at `8557cb6` as `9402a2c`. | `RunConsole.tsx` was last shaped by `4900661`, the browser pass #52 carries. |
| `7880e4b`, `d098217` closed enrollment, admin refusal copy, no remove button on admin rows | New small PR on main after #51 lands. | `admin.ts` and `AdminPage.tsx` sit on #51's admin changes; `cohorts.ts` is independent but the copy and docs were written together. |
| Flow branch `488ee38` (merged as `63b2b9d`), `b874f26` docs, `fa36163` fixture wording and log | Flow reliability PR from `fix/verified-flow-defects-20260930`, based on main after #2/#11/#14/#45/#46/#51/#52 and the SDK line. | `fa36163` extends `c6e3005`'s per-track fixture wording; `b874f26` corrects docs the flow commits made stale. The only merge conflict was two helpers appended to `RunDetailPage.tsx`; keep both. |
| `ff54625` report command label (merged as `0d07de1`) | Report-metadata PR from `fix/report-tier-20260930`, based on the flow PR branch. | `0d07de1` resolves `DashboardPage.tsx` by making `LocalReportsTable` serve both the track table and the flow PR's Other benchmarks table, without the Student column `4900661` removed. That resolution needs the flow PR underneath. Adds migration `0045_local_report_command.sql` (new file, not a rename); fresh and upgrade checks are in the candidate evidence. |
| `2aa05a8` `check` report names the adapter file it used | Same report-metadata PR; it is `ff54625`'s parent on that branch. | SDK-only (`cli.py`, `report.py`, `test_report.py`) and applies cleanly to the replayed step-36 tree. It needs nothing from the flow PR; it rides along because the branch already carries it. |
| `0d2ba7d` README: which command a synced report came from | Same report-metadata PR. | Documents `ff54625`'s field. Its README hunk does not apply to main after step 36 alone; `b874f26`'s README edits come first, hence the guide-PR fallback below. |
| `88e382d` faint ink `#5f6777` | Same report-metadata PR, below `53e9d53`. | No open PR owns the `--color-ink-faint` token: its value is unchanged since `89353d0`, and `app.css` was last touched by #18's `5a915da` (step 32). `e5a37c6` edits this commit's comment, so they ship together. |
| `53e9d53` overflowing report table is a named tab stop | Same report-metadata PR. | `LocalReportsTable.tsx` first appears in `ff54625`. The patch applies on the `0d07de1` resolution, not on `ff54625` alone. |
| `e5a37c6` focused report table stays reachable when overflow ends | Same report-metadata PR, after `53e9d53`. | Same file as `53e9d53` plus `88e382d`'s `app.css` comment; all three apply in order on `0d07de1`. |
| `ad14795` report-table comment trim, `97ec107` wash text contrast | Same report-metadata PR, after `e5a37c6`. | `ad14795` edits `53e9d53`/`e5a37c6`'s comments; `97ec107` edits `88e382d`'s `app.css` comment and moves two faint lines on the detect wash (`Feedback.tsx` QueryError next step, `LeaderboardPage.tsx` "not recorded") to ink-secondary. |

The guide PR in step 37 should also take the `python/cogbench/README.md` and
`docs/how-to/run-the-course.md` hunks of `b874f26` and `0d2ba7d` if the flow
and report PRs have not landed when it is assembled.

## Dry-run evidence and exact commands

`replay-b.py` writes to `/tmp/mergeplan-dry-20260930$DRY_SET-evidence/`
(`E` below) and creates worktree `CogPortal-mergeplan-dry-$DRY_SET-$DRY_NAME`
on branch `mergeplan/dry-20260930$DRY_SET-$DRY_NAME` (defaults `b` and
`suffix`) from the #22 merge commit. It merges, in order:

```text
45 51 46 52 41 25 29 44 4 3 38 28 31 10 17 47 50 2 11 14 18 20 21 43 48
```

It uses ordinary `git merge --no-commit --no-ff` with full SHAs: #52
`8557cb6`, #2 `b0a29af` (or the SHA given as its argument), and in #48's slot
the promoted SDK line, which it builds with `git merge-tree` from #12
`a7ecaab` and #48 `d0b6527` and checks against tree `26f3c94`. It resolves
only paths that conflicted in the previous proof's `replay.json`, the same
way, plus the two inspected new ones (#2 `pnpm-lock.yaml`, #21
`CodeContent.tsx`); any other conflict stops it. It also carries the step-27
rename, the step-36 deletion and reapplied hunks, and `3d4f43f` after
reproducing #50's three scorer-guard failures. `replay-b.log` keeps the
first run's stops at each new conflict and at the `test_resolve.py` context
mismatch. A second run from scratch (`DRY_NAME=verify`) finished unattended
with the same final tree, `3396bcc`. `replay-b.json` lists each step's merge
commit and conflicts beside the previous proof's; `tree-delta.json` shows
that each step's tree differs from the previous proof only in files the new
#52, #2 and #12 commits touch.

```sh
E=/tmp/mergeplan-dry-20260930b-evidence
T="/Users/samgu/Programming Projects/CogPortal-mergeplan-dry-b-suffix"
python3 "$E/replay-b.py" > "$E/replay-b.log" 2>&1
(cd "$T" && pnpm install --frozen-lockfile --offline) > "$E/install.log" 2>&1
pnpm --dir "$T" check > "$E/check.log" 2>&1
pnpm --dir "$T/apps/portal" exec env TSX_TSCONFIG_PATH=tsconfig.app.json \
  tsx --test test/admin-members.test.ts test/connections-link-command.test.ts \
  test/failure-presentation.test.ts test/refusal.test.ts test/run-source.test.ts \
  test/setup-check-off.test.ts test/setup-contract.test.ts \
  test/setup-evidence-scope.test.ts test/setup-rail.test.ts \
  test/restored-document.test.ts test/setup-completion.test.ts \
  test/setup-state-account-switch.test.ts test/code-highlighting.test.ts \
  test/run-console.test.ts > "$E/portal-focused.log" 2>&1
pnpm --dir "$T/apps/portal" test > "$E/portal-full.log" 2>&1
```

Results with #2 at `b0a29af` (set `b`):

- Offline install and whole-stack `pnpm check` exit 0.
- Fourteen focused portal files (the earlier nine plus #2's and #52's new
  tests) run 152 tests; all pass.
- Full portal suite: 659 tests, 3 failures, all in
  `leaderboard-scorer-version.test.ts` (see merge stops). The previous
  proof's final tree `99c7f51` fails the same three; candidate `7f1944e`
  passes them.
- Each changed step's own tree (`step-*.log`): 16a `code-highlighting` and
  `run-console` 29/29; 29 `restored-document`, `setup-completion` and
  `setup-state-account-switch` 25/25; 34 `code-highlighting` 15/15; 36
  `setup-completion` and `setup-contract` 7/7, covering the reapplied
  `SetupPage.tsx` hunks.
- Migrations still hold `0039_setup_check_source.sql` and
  `0040_run_repository_name.sql`; 0045/0046 are absent.
- Full SDK suite on the final tree, Python 3.8: 1230 tests, exit 0, 4
  skipped (`sdk-full.log`). The step-36 SDK tip alone passes the three #12
  modules (`sdk-tip-*.log`).
- Runner suite with the benchmark clones below: 488 tests, exit 0, 3
  skipped, as in the previous proof. Skips are uncovered cases, not green
  evidence.

The benchmark directories are empty gitlinks, so the runner needs local
clones at the pins, taken from the old proof's repositories
(`submodules.log`). An explicit source path avoids stale installed Vision
modules without changing the venv.

```sh
git clone --shared --no-checkout /tmp/mergeplan-20260930/bench/cogworks-week1-audio-benchmark "$T/benchmarks/week1"
git -C "$T/benchmarks/week1" checkout --detach 4e516f39ffbeefe579e093260b2865eb354c17a7
git clone --shared --no-checkout /tmp/mergeplan-20260930/bench/cogworks-week2-vision-benchmark "$T/benchmarks/week2"
git -C "$T/benchmarks/week2" checkout --detach a3dd948d0c108fabf070b4f159acdecd4d6c3897
git clone --shared --no-checkout /tmp/mergeplan-20260930/bench/cogworks-week3-language-benchmark "$T/benchmarks/week3"
git -C "$T/benchmarks/week3" checkout --detach 94c7e64f7e3bf5193be1805b4258f017d044a088
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$T/python/cogbench/src" \
  /tmp/care-hosted/pin30-venv/bin/python -m unittest discover \
  -s python/cogbench/tests -p 'test_*.py' > "$E/sdk-full.log" 2>&1
PYTHONDONTWRITEBYTECODE=1 \
  PYTHONPATH="$T/benchmarks/week1:$T/benchmarks/week2:$T/benchmarks/week3:$T/python/cogbench/src:$T/apps/runner-modal/src" \
  /tmp/care-hosted/pin30-venv/bin/python -m unittest discover \
  -s apps/runner-modal/tests -p 'test_*.py' > "$E/runner-source-paths.log" 2>&1
```

Results with #2's final head (set `c`, `DRY_SET=c python3 "$E/replay-b.py"
62f19276c969d721fc5d516d6e5b4350a051b602`):

- Every step has the same conflicts and resolutions as set `b`; each step
  tree from 29 on differs from set `b` only in `RestoreGate.tsx`,
  `restored-document.test.ts` and `bug-triage.md` (`tree-delta-vs-b.json`).
  The final tree `b767175` contains all of `b0a29af..62f1927`.
- Step 29's tree: `restored-document`, `setup-completion` and
  `setup-state-account-switch` 28/28 (`step-29-pr2.log`).
- Final tree: offline install and `pnpm check` exit 0; the fourteen focused
  portal files run 155 tests, all pass (`portal-focused.log`).
- Final tree, Python 3.8: `test_retained_scoring_input` 38,
  `test_weights_sync` 12, `test_cli_submission` 6, `test_lifecycle` 146,
  all pass (`contract-*.log`).
- The full portal, SDK and runner suites were not rerun for set `c`. The
  three changed files are portal-only, so set `b`'s SDK and runner results
  stand; the full portal suite's only failures there were the three step-14
  fixture cases, which this replay still reproduces because it does not
  apply `85b7fd4`.

Not rerun: unchanged benchmark suites, browser, Windows, hosted, Discord and
the seed/guide/pin stack. Reuse this proof for unchanged work only, not as
acceptance of a future repair head.

The benchmark clones were removed and their empty directories recreated,
then the four throwaway worktrees (`-sdk`, `-suffix`, `-verify`, and `-old`
for per-step and candidate checks) were removed without force and their
`mergeplan/dry-20260930b-*` branches deleted (`cleanup.log`). Set `c`'s
worktree and branch `mergeplan/dry-20260930c-suffix` were removed the same
way. The replay commits named here are now unreachable; rerunning the script
rebuilds them.

## Previous proof retained

- Original prefix and benchmark merge-vs-squash proof remain under
  `/tmp/mergeplan-20260930/`. No rerun was needed because those heads did
  not change. Original Python scripts and JSON record their full commands.
- `/tmp/mergeplan-20260930/cogportal/mergeplan_dryrun-D.json` supplies the
  unchanged #22 starting commit. `audit/alternative-replay.json` supplies
  #25 and later reference resolutions. Their original main was `5c2aa40`.
- The previous suffix proof, with #52 `82ab6ea`, #2 `d5e36a5` and #12
  `c91cfaf` (final tree `99c7f51`), remains under
  `/tmp/mergeplan-dryrun-refresh-20260930-evidence/`. Its `replay.json`
  conflict lists, `browser-setup.patch` and `scorer-guard.patch` are inputs
  to `replay-b.py`; its results are superseded.
- Earlier #47-on-`9524d0f` result, three saved-Vision failures, remains in
  `/tmp/mergeplan-20260930/cogportal/logs/runner-47-into-9524d0f.log`.
  It is superseded for the repaired #50 combination, not erased.
- Existing worktrees `CogPortal-mergeplan-47-into-9524d0f`,
  `CogPortal-mergeplan-dryrun-C`, `CogPortal-mergeplan-baseline-9524d0f`
  and `CogPortal-mergeplan-pr47-645b9e8` belong to the earlier audit and
  remain untouched.

After merging the seed/guide/pin stack, run CI and runtime acceptance on
that exact main head. It also includes main's `LICENSE`, `.coderabbit.yaml`,
`greptile.json`, and `t3.json`, which were absent from the old candidate,
and newer PR work such as `73b3b49`. Do not replace those with candidate
files while resolving conflicts.

## Remote PR map

Full SHAs below are the remote heads at observation time, not local repair
promises. The touched local refs all compare equal to their remote heads:
#2 `fix/pr2-session-recovery-20260930`, #11 `prmig/pr11-original-names`,
#12 `fix/pr12-interrupt-20260930`, #50 `pr50-saved-vision-fake-20260930`,
#51 `fix/pr51-ta-coverage-20260930`, #52 `fix/pr52-polish-20260930`. All
are pushed. `3d4f43f` is not part of #50's head. The local-only repairs
above have no PR here.

| CogPortal PR | Full remote head | Remote base | Local supplied head |
| --- | --- | --- | --- |
| #1 | `9c56d93bf2fe2afbaaa71f6d61fda1d49f654f20` | `main` | not supplied |
| #2 | `62f19276c969d721fc5d516d6e5b4350a051b602` | `feat/automatic-discovery` | matches, pushed |
| #3 | `0a82fc830ee1630f8c62ad477d93b40b031b6fb8` | `ci/runner-suite-imports` | not supplied |
| #4 | `a8c56c3a57bf864ed6950e3b154dc8c136113e8f` | `main` | not supplied |
| #5 | `738ae353fa581245a144a88b48f9a23ef8d72bc5` | `ci/runner-suite-imports` | not supplied |
| #6 | `a250b28b975cb66af4a18fda9a59df8f97781838` | `feat/cogbench-call-forms` | not supplied |
| #7 | `2c3ce222f4549791f220885a8e31d48a4a7c37cb` | `feat/cogbench-repository-read` | not supplied |
| #8 | `a4f21e4902be6fc19a39e06789ae10fac4765037` | `feat/automatic-discovery` | not supplied |
| #9 | `768988a6ca5df0925bee475d9f575435761857fb` | `feat/cogbench-bind-and-report` | not supplied |
| #10 | `98eecac9bfa3a18a7e85a5f210ec35c752778edc` | `feat/automatic-discovery` | not supplied |
| #11 | `6f70afd210d1b2009da12c1ca5cdf809c79c23e1` | `restore/guided-setup-rail` | matches, pushed |
| #12 | `a7ecaab286c624bf5134c74db44f042799d1dec8` | `feat/cogbench-terminal` | matches, pushed |
| #13 | `f26c3bddec05c097a6d750d846089f97777340d5` | `fix/hosted-candidate-readiness` | not supplied |
| #14 | `d50be7b8d2f028d25d00ee9ace24dd92da2c5bde` | `fix/run-keeps-its-repository` | not supplied |
| #15 | `12df96f2fc6e45516afafb6c9f2f3d06e6cb2c81` | `fix/hosted-language-week3` | not supplied |
| #16 | `0ac41e642727a99e6f00f23cd92e505b7b7f33a1` | `fix/week3-one-case-grid` | not supplied |
| #17 | `692ab15ebf0a0401099113cf0293f7c40d34230c` | `fix/discord-activity-entry` | not supplied |
| #18 | `9c651d0daecb511c138a794bc698d5c4a7f78a69` | `fix/run-source-action-eligibility` | not supplied |
| #19 | `c701d341c8e965105f038a95c0927c700fb6a0a3` | `fix/hosted-candidate-readiness` | not supplied |
| #20 | `75ec3cbb76a75a5090e9dc45d601eb6d0dae46ad` | `polish/setup-commands-and-icons` | not supplied |
| #21 | `cf4e3a48db97612b0d99b96ce450eb775702b8a7` | `feat/same-console-recovery-20260911` | not supplied |
| #22 | `f0cb021ce7fec0a543b64fb6371188928f8614aa` | `fix/week3-evaluation-resource-scope` | not supplied |
| #23 | `d595e5dfe2125775f7deca20d14b4f2311cd43b4` | `fix/week3-evaluation-resource-scope` | not supplied |
| #24 | `e264e1da435c6d517da4e5533d9c1e729069dcbd` | `fix/hosted-candidate-readiness` | not supplied |
| #25 | `727f98798e0ef2d1b1258965622fd81d902f60e6` | `fix/sdk-saved-metric-roles` | not supplied |
| #26 | `6af6a06ac84694029e6aa09ff612336934191bf6` | `fix/production-release-config` | not supplied |
| #27 | `7f1e9bc52f223cc6d8e177cfffafa68fa3a997fb` | `fix/immutable-weight-artifacts` | not supplied |
| #28 | `194ef7bcf279203c791f80a4978b6c06724f17b1` | `ci/runner-suite-imports` | not supplied |
| #29 | `73ffbe080540b737dd4a4c6461bb2f2b0e8c3ee1` | `fix/sdk-retained-scoring-input` | not supplied |
| #30 | `baab265ba0087d30b4f9dfd976ac07863a40bb2d` | `fix/production-release-config` | not supplied |
| #31 | `9dcacf3bedb74048e4c27e6106ed338f4518f500` | `ci/runner-suite-imports` | not supplied |
| #32 | `5042fcbf2a35ba121667d5f34bb13ce8db7df5c3` | `fix/cogbench-process-boundary` | not supplied |
| #33 | `2a4275cddd34c5134ef2c5a292ffeed4f1c0b1d6` | `fix/production-release-config` | not supplied |
| #34 | `19f26e5fc352e07d656f331d67617144f5478cbc` | `fix/week2-image-celeba-pr` | not supplied |
| #36 | `ce71ab65b809c723eb757a2b8dcd93178770b678` | `fix/failure-detail-cut-at-a-word` | not supplied |
| #37 | `4ed02ed29cbb2f09ef34da40bf4d2b9b0dd68410` | `fix/production-release-config` | not supplied |
| #38 | `b74313af43e821d91de12ee0bda601bb9007a37a` | `main` | not supplied |
| #40 | `c8078aa23530fa54d6f8b3005094b8f1517bb221` | `main` | not supplied |
| #41 | `2fa6fe98682407ceebea427ea548fc9f6fe3a795` | `feat/automatic-discovery` | not supplied |
| #42 | `cbeb8192b5888afa17c59a61500d9bde67367daa` | `fix/production-release-config` | not supplied |
| #43 | `cdd9adce115bebc323945d35da3dceec531cb3d5` | `polish/readable-run-and-admin-ui-20260914` | not supplied |
| #44 | `87cc947a489a6f10294148d34631ff4b3c4402cc` | `feat/automatic-discovery` | not supplied |
| #45 | `6d95bda46ca970159cfd3c04712381ad7528df86` | `integration/ui-hosted-bridge-20260914` | not supplied |
| #46 | `b0bc461280d7ef6a7d3484b7bc7c29b01cbc2b66` | `perf/free-plan-route-cpu` | not supplied |
| #47 | `645b9e8eaef74ce5e56ca726697aaa2ed90a3696` | `fix/failure-detail-cut-at-a-word` | not supplied |
| #48 | `d0b652756ff87dee936e76f9a0a69418a9ed2385` | `fix/resolver-refusal-names-the-week` | not supplied |
| #49 | `e507e03967e543677189df81e398096ae5c6d42c` | `main` | not supplied |
| #50 | `c4901e5819a759dcfa82206eccab439c00eca141` | `fix/runner-attribution-release` | matches, pushed |
| #51 | `5ffc0d161a1a7fa19402177346fdedd3324b28d7` | `perf/free-plan-route-cpu` | matches, pushed |
| #52 | `8557cb6497bc29c1db97e5c8615d7e590a01ec8f` | `fix/run-team-status` | matches, pushed |

| Benchmark PR | Full remote head | Remote base | Release disposition |
| --- | --- | --- | --- |
| Audio #1 | `89f8d948cdb4a5cb27e897d787054d148153af40` | `main` | excluded sibling |
| Audio #2 | `4e516f39ffbeefe579e093260b2865eb354c17a7` | `main` | pinned chain |
| Vision #1 | `11a8baf6f991b177b9d9dd95204bbf9bd027ddf2` | `sg/week2-benchmark-adapter` | pinned chain |
| Vision #2 | `b9055031bf25a18594651d89610f3fbcd7462db8` | `feat/recognition-discovery` | pinned chain |
| Vision #3 | `ae8d974a0e10125b6850803863482e14455cc3ea` | `feat/recognition-retention` | excluded sibling |
| Vision #4 | `f763390cbdbe3722a6ee5b083e791420255aaf43` | `feat/recognition-retention` | excluded sibling |
| Vision #5 | `c177cf23cdd4f8dbe55401a2eb4bada4c64d37c2` | `main` | pinned chain |
| Vision #6 | `a3dd948d0c108fabf070b4f159acdecd4d6c3897` | `feat/recognition-retention` | pinned chain |
| Language #1 | `1004766b66a4405ceda1a1b014a0438098a6570e` | `main` | pinned chain |
| Language #2 | `cc67edbc989df52e4273eced849603dc0ee802f5` | `feat/retrieval-rung-metadata` | pinned chain |
| Language #3 | `3f266e10ab50611d087da4786052673ef89d03a7` | `fix/retained-scoring-input` | excluded sibling |
| Language #4 | `6dc63fe8f6af2b3554a21f7707debb138f31ae4e` | `fix/retained-scoring-input` | pinned chain |
| Language #5 | `94c7e64f7e3bf5193be1805b4258f017d044a088` | `fix/language-diagnostic-cause` | pinned chain |
