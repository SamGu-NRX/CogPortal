# Hosted, release, vision and weights PRs: caretaker report

Snapshot taken 2026-09-18 against heads listed in the Greptile table. No branch
was pushed. Bodies of #23 and #30 were corrected on GitHub. Watch active on
all fourteen PRs.

## Benchmark-repo landing table

Week 3, `SamGu-NRX/cogworks-week3-language-benchmark`, main at `b166f5c`.
Open PRs: #1 `feat/retrieval-rung-metadata` -> main (head `1004766b`);
#2 `fix/retained-scoring-input` -> #1 (head `cc67edb`); #3
`fix/extracted-project-resources` -> #2 (head `3f266e1`); #4
`fix/language-diagnostic-cause` -> #2 (head `6dc63fe`).

| Pinned SHA | Pinned by (CogPortal) | Where it lives | Must land first | Merge commit | Squash or rebase-merge |
|---|---|---|---|---|---|
| `1004766b66a4405ceda1a1b014a0438098a6570e` | #15, #16, #23, #26, #30, #33, #34, #36, #37 gitlink and `validate_week3_submodule.py` | head of PR #1 | #1 | SHA preserved | pin becomes #1's squash commit, unknown until merged |
| `fff786537567939936bf65042c09cdea27c90798` | production source `20889b5`; #23 `benchmark-packages.ts`; #25 | interior commit of PR #2 (two commits below its head) | #1, #2 | preserved | not preserved and not replaceable one-for-one: #2's squash also carries `51363ba` and `cc67edb`, so the pin would move to that squash |
| `6dc63fe8f6af2b3554a21f7707debb138f31ae4e` | #29 gitlink, validate, `plugins.py`; #30 install line | head of PR #4 | #1, #2, #4 (#3 is a sibling, not required) | preserved | pin becomes #4's squash commit |

Week 2, `SamGu-NRX/cogworks-week2-vision-benchmark`, a fork of
`iReynaldo/ComputerVisionBenchmark`; both mains at `79bc725`. Open PRs on
the fork: #1 `feat/recognition-discovery` -> `sg/week2-benchmark-adapter`
(head `11a8baf`); #2 `feat/recognition-retention` -> #1 (head `b9055031`);
#3 `fix/extracted-project-resources` -> #2 (head `ae8d974`); #4
`fix/vision-diagnostic-causes` -> #2 (head `f763390`). The branch
`sg/week2-benchmark-adapter` (head `c177cf23`, on both remotes) has no PR to
main and is not merged into main.

| Pinned SHA | Pinned by (CogPortal) | Where it lives | Must land first | Merge commit | Squash or rebase-merge |
|---|---|---|---|---|---|
| `c177cf23cdd4f8dbe55401a2eb4bada4c64d37c2` | #8, #13, #15, #16, #23, #24, #26, #27, #30, #33, #34, #36, #37 gitlink, `validate_week2_submodule.py`, `plugins.py` | head of `sg/week2-benchmark-adapter` | a PR for that branch -> main, which does not exist | preserved | pin becomes that squash |
| `b9055031bf25a18594651d89610f3fbcd7462db8` | #19 gitlink and validate; production source `20889b5`; #23 and #25 installers | head of fork PR #2 | the adapter branch, fork #1, fork #2 | preserved | pin becomes fork #2's squash |

Reachability notes. A squash leaves the old SHA on GitHub until garbage
collection, so `git submodule update --init` keeps working for a while and
then stops without warning; treat it as broken from the merge. `b9055031`
exists only on the fork, while `.gitmodules` on #19 still names
`iReynaldo/ComputerVisionBenchmark`; `git fetch origin b9055031...` against
the parent succeeded here through fork-network object sharing, which is why
#19's CI passes. It depends on the fork existing. #3
(`fix/week2-submodule-fork`) is the PR that moves the URL.

## Per-week pin values

Production (`20889b5`, Modal `cogworks-runner-production` v2) runs Week 2
`b9055031` at the SamGu fork and Week 3 `fff7865`, in all four places.

- Week 2: `b9055031bf25a18594651d89610f3fbcd7462db8` at
  `SamGu-NRX/cogworks-week2-vision-benchmark`. Matches production; no PR in
  this group moves it. Set by #19 (gitlink, `validate_week2_submodule.py`)
  and #23 (`benchmark-packages.ts`); outside this group by #3 (`.gitmodules`
  URL) and #25 (`plugins.py`).
- Week 3: `6dc63fe8f6af2b3554a21f7707debb138f31ae4e`. #30 deliberately moves
  the install line there and #29 moves the other three places. Diff
  `cc67edb..6dc63fe` (week3 PR #4): diagnostics wording, failure notes
  grouped per reason, chance floors no longer repeated as a note, and a
  search score kept instead of withheld when the image side never bound;
  formulas, roles, relations and version unchanged. Set by #30
  (`benchmark-packages.ts`) and #29 (gitlink, `validate_week3_submodule.py`,
  `plugins.py`). #15 stays at `1004766b` as its own code dependency
  (`6dc63fe` descends from it); the gitlink conflict when both land resolves
  to the newer SHA, as Sam's comment on #16 says.

Inside #23's lineage today the four Week 3 places read `1004766b`
(gitlink), `1004766b` (validate), `b166f5c` (`plugins.py`), `fff7865`
(`benchmark-packages.ts`), and the Week 2 places read `c177cf23` three times
and `b9055031` once. #29 and #3/#25 landing closes both gaps; nothing in
this group needs to move for that.

## Greptile: last real review per PR

The Sept 16 `@greptileai` re-requests all returned "reached the 50-credit
limit", so these are the reviews of record. "Own" means commits on the PR
branch that are not in its base. Every inline finding on the reviewed heads
is fixed with a SHA or answered on its thread and resolved by the owner; #36's
two threads are open.

| PR | Reviewed head | Current head | Own commits since | My read of the range |
|---|---|---|---|---|
| #8 | `7772f03b` | `43bd7a43` | 15 | Smoke-tool usage errors (6c02a40, 89a7484, db47058) answer the two threads. `43bd7a4` captures the base image id after `Sandbox.create`. The branch also carries the same-console retry feature merged from Foundation (`5bb53ce`..`788dba4`, also on #20), so #8's diff against #1 is 83 files, 5848 insertions, far past its title; that scope is a decision for Sam, not a defect. |
| #13 | `c811adea` | `fbf782e2` | 1 | `30a6e5b`: migration 0043 sets `language-search` sandbox contract 2 and `SANDBOX_CONTRACTS` agrees; the frozen six-case decoder is refused before scoring. Consistent. |
| #15 | `6a37eac4` | `aaf1263e` | 8 | Pin moves to `1004766b`; fixture adds the three retrieval rewrites; count-mismatch copy now covers v1 and v2 lists without sending the student to look for a skipped case. No defect. |
| #16 | `635537f5` | `b0b3a4e5` | 3 | `a7a063e` materializes `benchmark.run` inside the course-file and capture scopes in all four branches, which the P1 asked for; `4697770` pins it with an AST test. Correct. |
| #19 | `59115993` | `850c33cf` | 6 | Clustering stays at contract 1; stability repetitions travel as `scored`/`scenario_key` with defaults for older bundles; the materializer counts only scored cases. Consistent with the release-gate reply on the P1 thread. |
| #23 | `7017e56d` | `5fe41c49` | 14 | `52486e6` adds `--build-only` and explicit publication and the failure-safe receipt (both threads). `97523a0` adds `deployment.py`. Ran `python3.8 -m unittest discover -s apps/runner-modal/tests -p 'test_deploy*.py'` on `5fe41c49`: 46 OK. |
| #24 | `514ed5e4` | `514ed5e4` | 0 | Reviewed at head, 5/5, no threads. |
| #26 | `cee499e3` | `e74825cc` | 3 | Docs only; drops an invented defect and two loose claims. |
| #27 | `88de1931` | `88de1931` | 0 | Reviewed at head, 5/5, no threads. |
| #30 | `1b00cb5f` | `cc496a0f` | 3 | Rationale comment then the move to `6dc63fe`; `benchmark-install.test.ts` 6/6 on `cc496a0`. Body corrected to say the cited run is on `cc67edb`. |
| #33 | `5fe75209` | `2a4275cd` | 2 | `2a4275c` makes the bake read `XDG_CACHE_HOME` from the image and refuse when unset, the fix Sam's comment describes. |
| #34 | `197c13b2` | `19f26e5f` | 4 | Detail and diagnostic caps counted in UTF-16 units to match `z.string().max`, short text returned unchanged, cut at a word and marked. Correct; a lone surrogate no longer raises inside failure handling. |
| #36 | `844f66cf` | `ce71ab65` | 1 | `ce71ab6` moves the platform-fault signal from a text match to a status read out of `/tmp/discovery.json`; the author's own comment shows that file is writable by repository code. Draft, open threads, recommendation below. |
| #37 | `d19adf27` | `31992f28` | 1 | Runbooks now name `cogportal-artifacts-prod` as bound, the P2 thread's ask. |

## #36 recommendation: close

The incident it exists for (Week 2 image without CelebA; a student told "no
adapter found" for code that scores 0.93 and 0.76) is removed by #33, which
bakes both tiers and validates them at image build. The branch's channel reads
`/tmp/discovery.json` after repository code has run, so a repository can
relabel its own failure as ours, which the author confirmed in the Sept 15
comments; the correct channel is the pristine probe's contract
(`prepared_environment`), a different PR. That makes this an additive patch
for a situation nothing now produces. Close with the positional rule
recorded in the closing comment; if it recurs, open a fresh PR against the
pristine probe. Sam decides; nothing is done to #36 until relayed.

## Readiness

None ready. Every PR here descends from #1 (`feat/automatic-discovery`),
which is open. Checks are green on all fourteen heads (Macroscope skipping by
policy); merge state CLEAN everywhere. #8 becomes the first candidate once #1
merges and #8 is retargeted to main.

## Merging #1's sweep (da36ac8) up the group, 2026-09-19

#1's head moved from `d55ce44e` to `da36ac8` (its owner's deslop sweep plus
`11bca3f`) and #8 went DIRTY. The new head was merged into every owned branch
and tested at each step; the conflicts were:

- `modal_app.py` (#8, #16): comment hunks where #1's sweep and #8's
  refund-wording rewrite touched the same lines; resolved to #1's text, #8's
  code kept.
- `maintenance.ts` (#8): #1's sweep re-touched the reaper next to a line #8
  had removed (`a0e8eac` dropped the official-attempt release), leaving a
  `const eligibleExists` nothing reads and no `exists` import; the line is
  dropped. Left in, `tsx` threw at runtime and 14 reaper tests failed.
- Weight routes (#24): #1's `11bca3f` fixed the Hono 4 `c.req.param("*")`
  bug by switching both routes to `:path{.+}`; #24 fixed the same bug with
  `weightPathFromRoute`, which reads the raw pathname so `%2F` in a segment is
  refused rather than decoded into a separator, and which requires the `*`
  route. The merge keeps #24's handlers and restores the `*` registrations.
  When #1 lands on main, #24's diff will show that route change reverting; the
  merge commit `e264e1d` says why.
- `benchmark-packages.ts` and `platform.md` (#23): #1 reworded text #23 had
  replaced; resolved to #23's.

Heads after the merge: #8 `c7efcdc`, #13 `f26c3bd`, #15 `12df96f`, #16
`0ac41e6`, #23 `b85155a`, #26 `6af6a06`, #30 `2a5a837`, #37 `4ed02ed`, #42
`e4cdfeb`, #19 `c701d34`, #24 `e264e1d`, #27 `7f1e9bc`. Runner suite (Python
3.8), `pnpm check`, portal and bot tests green locally at every step that
carries the affected code.
