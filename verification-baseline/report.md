# CogPortal baseline verification, September 10

For the manager and Opus implementation owner. This pass identifies repairs and the prerequisites for the next acceptance pass.

Browser observations were made on September 10, 2026, with screenshots timestamped 08:35–08:41 UTC, at `https://cogportal-dev.sillion.app` and `https://cogactivity-dev.sillion.app`. Helium was confirmed through the native `net.imput.helium` window, whose tabs matched extension browser `2`. Owned tab `1693191317`, group `🔎 CogPortal baseline verification`, is left on the Audio dashboard for continuation. The manager's restoration tab was untouched.

Source evidence below is from **c2af39660ef2ecde9ace1fd50d9e8c5efa36ab45** using `git show`, not this worktree's HEAD, which is **2747b674d6d34c3f2d6c7debd7dda3918e05680c**. The browser does not expose a deployment SHA. These are observations of the live development site and separately identified baseline-source explanations, not proof that its deployed bytes exactly equal c2af396. The integration workspace was only read for existing product-description records, which already contain some restoration expectations and still mark checks `not run`.

## Repairs supported by this pass

1. **P1, setup evidence claims verification for whichever benchmark is selected.** On `/setup`, Sam's Audio guide shows 5/5 verified. Choose Semantic Image Search. The install command changes to the Week 3 package and the check changes to `language-search`, but both remain Verified and the header remains 5/5. See [Audio](setup-audio.jpg) and [Language](setup-language.jpg). This is a demonstrated state transition, not evidence that Sam has never checked Language. Source establishes the deeper limitation: setup evidence stores only user, team, step and time, so it cannot establish which benchmark the project/wiring evidence checked. `apps/portal/worker/db/schema.ts:230–238`, `worker/routes/setup.ts:27–46,85–102`, `src/lib/setup-progress.ts:107–132,146–164`. `useSetupState` has a single query key and stops polling after the shared machine steps are complete, `src/lib/queries.ts:258–271`. Related existing IDs `SETUP-02`, `SETUP-03`; no new tracking ID allocated. Repair the evidence scope or narrow the claim to what that evidence actually proves. Do not add browser-owned progress alongside the server's record. Recheck a local fixture with Audio-only evidence while switching to both Vision and Language, then run the selected check and observe its update.

2. **P2, hosted metrics lose their semantic roles before rendering.** Open `/runs/run_bb29405e29`, scroll to Results. Chance `0.033` has an upward arrow and the accessible label “higher is better,” despite its help calling it the dataset floor. [Screenshot](audio-metrics.jpg). `RUNPAGE-04` fails. The renderer already suppresses direction for `role: floor`, `src/components/MetricBlock.tsx:77–100`. The baseline database has no role/relationship columns, `worker/db/schema.ts:573–592`; callback persistence drops `role` and `relatesTo`, `worker/routes/runner-events.ts:142–166`; the serializer cannot return them, `worker/http/serializers.ts:54–64`. The contracts accept both fields. This also prevents hosted rendering from applying the intended reported-probe and floor relationships. Repair metadata persistence/serialization at the owning boundary and inspect `worker/execution/sync.ts` as the other writer. Do not patch the UI by guessing metric names. The original Audio callback payload was not retrieved, so this pass does not establish whether that scorer supplied a floor role. Inspect its pinned scorer definition as well. Test an actual stored/reloaded result, not only a component given an in-memory metric. Also check orphaned floors: `SupportingMetrics` filters related floors out even when their parent is absent, `MetricBlock.tsx:190–206`, which matters for the existing withheld-metric checks `RUNPAGE-02–05`.

3. **P2, instructor usage fractions compare different scopes.** Open `/admin`, expand CogPortal. It shows `6 runs`, `5/10 · 1/3`, and `Published score 0.898` without a benchmark name. Audio `/dashboard` shows `4/10 · 0/3`; current Clustering v2 has no runs and `10 of 10 hosted · 3 official`. See [admin](admin.jpg), [Audio dashboard](dashboard.jpg), [Clustering dashboard](dashboard-first-clustering.jpg). Existing `B-09c`, `ADMIN-01`. The query counts practice runs and official attempts across all benchmarks and versions, `worker/routes/admin.ts:76–83`, but `src/routes/AdminPage.tsx:519–520` divides those totals by the limits for one benchmark version. The published score query chooses the latest selection across all benchmarks, `worker/routes/admin.ts:91–103`. No current numerator exceeded its limit during this pass. The mixed scope is verified; exceeding the limit remains a fixture test. Small repair: label aggregate counts as counts without per-benchmark denominators, or return a real per-benchmark breakdown if the manager needs quota inspection. Identify the benchmark/version next to any published score.

4. **P2, Discord calls hosted practice free. Source-confirmed, guild execution blocked.** Existing `B-09b`, `COG-06`. `apps/discord-bot/src/commands.ts:512–516` says “It's practice and spends nothing.” The action consumes the per-benchmark/version practice budget enforced in `apps/portal/worker/services/run-actions.ts:251–256`. Change that confirmation to distinguish the hosted practice slot from official attempts. Its neighboring promotion explanation also says “nothing reruns,” `commands.ts:518–520`; check that wording against hidden evaluation before treating it as accepted. No Discord command was invoked and no channel message was sent.

The first three findings fit Sam's concerns about duplicated truth, fixes at the wrong layer and patches to an incorrect premise. The narrow repair is to preserve scope and provenance through the existing owners. This pass found no reason for another progress framework, new timeout, separate UI state store or production component made only for tests.

## Browser checks and evidence

| Existing IDs | Result and limit |
| --- | --- |
| SIGNIN-06–08 | Signed-in `/` still shows a heading, five-word sequence and two links, with no four-step guide, attempt explanation or existing-repository guidance. Known restoration target. Signed-out variants remain untested. `landing.jpg`. |
| SIGNIN-01–02 | Not executed. Existing signed-in `/signin` redirects to `/dashboard`; that does not establish fresh-account or return-to behavior. |
| SETUP-02 | Five textual Verified states observed, matching the header. A real screen reader was not used. The benchmark provenance failure is above. |
| SETUP-03 | Audio to Language and back updates benchmark install and check together. Common clone/tool/link commands stay common. No new install or check was run. |
| SETUP-06 | Pass on the completed returning guide: five verified entries and 5/5 header. |
| SETUP-08–09, SETUP-11–12 | Baseline fails the restored teaching/ending expectations: bare comment-led commands and Open dashboard, without the explanatory sections. These are already within the restoration brief. |
| SETUP-13–14 | `--force-reinstall` is visible only on the CLI installation command. The CLI pin is `8e09a07c6e0cce75c70845d4566fd756f390c83b`. The actual reinstall check in SETUP-13 was not run. SETUP-14 passes. |
| START-07–08 | Current Clustering v2 displays FIRST RUN and local commands, but no reason-first explanation of local versus hosted work. Returning Audio budget displays counts without the required explanation of uncounted local runs or evaluation-stage official cost. Restoration targets. |
| RUNPAGE-01 | Pass on RUN 5E29: “What this run shows” precedes Results and the primary score. Existing succeeded practice run remains `0.5375`, `3m06s`, student repository SHA `71258046e60fecd3295c0b52236fc6e476b0e9cf`. This was a read, not a new hosted execution. |
| RUNPAGE-04 | Fail, Chance direction, detailed above. |
| RUNPAGE-06 | Function trace displays spectrogram, peaks, fingerprints, store and query with the bound function names. Inputs/outputs are shown for the first three; store/query show only function names. Do not mark the stronger every-row input/output claim fully passed. |
| RUNPAGE-12 | Existing log contains only `student python 3.8.20`; insufficient data to exercise fourteen-line expansion. |
| PROMOTE-* | Quota and Promote control visible, showing three remaining official attempts. No promotion, confirmation, publication or artifact recovery executed. |
| BOARD-01 | Standings render while signed in. Signed-out access untested. |
| BOARD-05 | Overall explains that Recognition and Clustering must come from the same commit, while Clustering has one archived row. Did not create a partial live-team selection to test inclusion. |
| BOARD-06 | Archived Audio row expands to metrics, completion date and anonymized-course explanation. No commit or repo link appears, consistent with archive privacy; the unqualified checklist expectation has drifted. Live published-row disclosure untested. `board-audio-archive.jpg`. |
| BOARD-07 | Pass on Recognition: “No official results are published yet. Check again after teams publish their results.” Vision Overall has a separate useful explanation and links through the visible sub-tabs. |
| Other board observations | Audio has four archive rows; Clustering one; Language four. Archive provenance is explicit. This is published-result inventory, not corpus compatibility. `board-language.jpg`. |
| TEAM-02 | Change repository opens the real GitHub repository picker and Cancel closes it. No target selected or confirmation armed, so consequence confirmation remains untested. |
| TEAM-04 | Pass for the observed owner view: stage rows contain names and date spans, no per-person counts or percentages. Panel loaded from recent commits and runs. `team.jpg`. |
| ADMIN-01 | Mixed-scope usage verified, exceeding-limit case untested. See finding above. Owner view loads two live teams and exposes roster/assignment controls. No staff, member, quota or enrollment changes made. |
| LINK-09 | Confirmed existing `B-32` label mismatch: Connections says “CogWorks CLI” in its explanation but heads the device section “COGBENCH DEVICES.” Existing linked Discord identity and rehearsal device visible. `connections.jpg`. |
| ACT-07 | Pass at `https://cogactivity-dev.sillion.app/`: “Open the live bench from Discord,” `/cog`, Open live console, and a link to the portal. `activity-browser-fallback.jpg`. |

Screenshots are real browser viewport captures, saved directly from CUA bytes. Most are the initial page position; `audio-metrics.jpg` was taken after scrolling to Results/Promote. `audio-metrics.jpg` was also visually inspected. No responsive-width or reduced-motion override was applied. The captures are JPEG, 1491 × 782 or 1506 × 790 pixels. Full motion behavior and keyboard traversal remain unverified.

## CLI evidence at the exact source revision

The baseline CLI package was exported with `git show` into `pinned-source/python/cogbench/src/cogbench` under this report directory. It was not installed, and no student code ran. Commands used `PYTHONPATH` pointing at that export, `PYTHONDONTWRITEBYTECODE=1`, an unused `COGBENCH_CONFIG` path here, and no `COGPORTAL_URL`. Existing credentials were not read or changed.

| Existing ID | Actual invocation | Result |
| --- | --- | --- |
| STATUS-02 | `python3 -m cogbench status` | Pass, empty stdout, exact no-portal sentence, exit 2. |
| STATUS-03 | `python3 -m cogbench status --portal http://example.com` | Pass, HTTPS requirement, exit 2. |
| STATUS-04 | `python3 -m cogbench status --portal https://user:pw@example.com/x` | Pass, same HTTPS requirement, exit 2. Dummy credentials, locally rejected. |
| REPORT-02 | `python3 -m cogbench report` in this report directory | Pass, no-reports sentence naming `cogworks run`, exit 2. |

Raw output and command arrays are in [cli-observations.json](cli-observations.json). `--help` also exits zero and lists `test`, so RUN-09's “hidden test” wording is document drift.

The existing `python/cogbench/tests/test_report.py` was exported from c2af396 and run with `python3 <exported-file> -v`. All **16 tests passed**, output in [report-tests.txt](report-tests.txt). This is isolated report-rendering evidence for parts of CHECK-03–06 and CHECK-10, not execution of those checklist scenarios against a student repository or hosted run. It does not prove current aggregate compatibility.

## Precise prerequisites for the next pass

| Remaining checks | Needed |
| --- | --- |
| SIGNIN-01–05,09; JOIN-01–07; CONNECT-01–07 | Manager-supplied local URL with separate fresh, member and owner identities; controlled GitHub-empty/error/private/read-only cases. No logout or reset of Sam's development session. OAuth account choices stay with Sam if real OAuth is necessary. |
| SETUP-01,04–05,07,10,13; completion acceptance for 02–03,06,08–12,14 | Final restoration commit and matching server; new-student incomplete and returning complete fixtures; safe linked CLI config and repository. Need Audio-only setup evidence to test cross-track correctness. |
| START-01–06; WATCH-01–07; RUNPAGE-02–05,07–12 | Local fixtures for active, refused, failed, official and long-log runs, plus withheld Language diagnostics. Real execution/callback checks need a separately authorized hosted attempt and known candidate revision. |
| PROMOTE-01–08; BOARD-01–06,08 beyond observations above | Local official-success/exhausted/stale-artifact fixtures and safe publishing controls. Signed-out board fixture; inactive tracks; non-archive published rows. No real promotion or publication during baseline. |
| TEAM-01–03,05–11; ADMIN-01–08 beyond observations above | Separate member, assigned TA and owner identities; throwaway repository/member actions; co-author and expired-token fixtures; multi-benchmark counts exceeding one benchmark's limit. |
| Remaining STATUS, CHECK, REPORT, RUN, LINK and all SYNC IDs | Safe local linked-device config, team repo, benchmark packages/data, saved reports and controlled portal responses. CLI report/sync success was not re-executed. Broad historical corpus recovery remains T3-owned. |
| COG-01–14; ACT-01–06,08–09; CHAN-01–10 | Designated test guild/channel, matching development bot, linked test identities and authorization for test-only messages, bindings and shared runs. Real Discord session/permission/channel-delivery behavior is not verified by ACT-07 or source reading. |
| Sandbox and cross-cutting checklist | Existing raw run records can support historical observations, but dynamic prepare/discovery/scoring/timeout/refund/replay checks need controlled local fixtures or explicitly authorized candidate executions. No sandbox checklist row was newly executed in this pass. |

All existing verification rows not explicitly covered above remain unexecuted here. No whole-product acceptance or compatibility ratio is claimed. This worktree contains only this report, screenshots, raw output and pinned evidence files as untracked additions; product source, tests, integration records, Git index, PR and deployment state were not changed.
