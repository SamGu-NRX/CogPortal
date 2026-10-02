# What the portal claims

## Summary

The platform has a rule about its own honesty: it only says what it observed. That rule produces a small vocabulary (*verified*, *self-reported*, *refused*, *could not look*, *withheld*, *floor*, *supplied*) and this document owns every one of those words. Other documents use them and link here.

The rule exists because of what the platform is for. It is an instrument that reports findings, not a judge that issues grades (`docs/design/the-instrument-not-the-judge.md`). An instrument that reports a number it did not measure is broken in a way a low number is not.

There is no screen called "what the portal claims". The words appear as tick marks on the setup page, a label beside the local reports, a sentence at the top of a run page, a "not scored" tag, a floor drawn beside a score, and `SELF-REPORTED` on a terminal report.

## The simple case

A student runs the benchmark on their own laptop and gets `0.6412`. They sync it. It appears on the Runs page under "Local reports", labeled "Self-reported, not promotable", with no name beside it, and it can never reach the leaderboard. Then they start a hosted practice run on the same commit. The portal runs the code itself, gets its own number, and that run can be promoted. The two are never mixed and never compared as though they were the same kind of claim.

Sometimes the platform has to say it does not know. It says so as a sentence with a reason, not as a zero and not as an error.

## The vocabulary

### Verified

The portal observed it. Used for a hosted run's metrics and stages, a device approval, and setup steps that the CLI on a linked device reported.

The setup page draws two kinds of tick and names them differently (`apps/portal/src/components/StepRail.tsx:34`). A filled green mark is read aloud as "Verified." and means a linked device's `cogworks check` reported the step. An outline mark is "Checked off from your terminal." and means the student ran the page's one-line check-off command, which records the step "as self-reported" (`apps/portal/worker/routes/setup-check-off-token.ts:8`). The progress line says who ticked what, for example ": 3 seen by the portal, 2 checked off by you" (`apps/portal/src/routes/SetupPage.tsx:456`). On completion the panel reads "Everything the portal can verify checks out. Your terminal found the repository and called your code." only when every step was seen; otherwise "Every step is ticked; the ones marked checked off are your own report rather than something the portal saw." (`SetupPage.tsx:424`).

Both kinds start on the student's machine. "Verified" here means the portal received a report from the CLI's own check over an authenticated device; it does not mean the portal inspected the machine. See the open questions.

### Self-reported

A result the student's own machine produced. The terminal prints it on the first line of every local report as `{benchmark} v{version} · LOCAL RUN · SELF-REPORTED`, or `LOCAL TEST` for a `cogworks test` report, or plain `LOCAL` for a report saved before the command was recorded (`python/cogbench/src/cogbench/cli.py:214`, `:230`). `cogworks sync` prints "Synced {report_id} as LOCAL RUN · SELF-REPORTED." (`cli.py:1336`).

On the Runs page, synced reports sit under "Local reports" with the label "Self-reported, not promotable" (`apps/portal/src/routes/DashboardPage.tsx:284`) and the margin note "These come from `cogworks sync` on your own machines. We show them as they arrived and can't check them, so they stay off the leaderboard." (`DashboardPage.tsx:318`). The table has no author column, because "a name beside a score reads as that student's grade" (`apps/portal/src/components/LocalReportsTable.tsx:16`). Discord's local view ends "self-reported, never leaderboard-eligible" (`apps/discord-bot/src/commands.ts:389`), and the run bubble never counts a local result as a team best (`apps/portal/worker/services/discord-messages.ts:152`).

> Technical note: `sync_report` removes `outputDigest` before sending (`python/cogbench/src/cogbench/client.py:94`). The portal receives metrics and notes, not evidence it could re-check, which is the honest shape for a claim it labels self-reported anyway.

### Refusal

The platform declining to give a number, stated as a sentence with a reason. A refusal is not a zero.

The structured refusal reaches a run only when preparation could not find code to score (`apps/runner-modal/src/cogworks_runner/modal_app.py:1579`). It carries a status, a headline, a next step when the platform knows one, the trace, notes, the files that could not be read and the lines the team's code raised on. The run page draws it inside the failure card as "refused at {stage}" followed by the headline in large type (`apps/portal/src/components/RefusalCard.tsx:126`). How much of it each surface shows is in [`../cross-cutting/refusals-and-disclosure.md`](../cross-cutting/refusals-and-disclosure.md).

The next step is empty when the platform does not know one, because a confident wrong explanation costs more than none (`packages/contracts/src/protocol.ts:130`).

### Could not look

The refusal for when the platform cannot say what is in the repository because it could not read part of it. "We looked and found nothing" is a claim about the repository; "we could not look" is a claim about the search. Reporting the first when the second is true was a real failure: three Week 2 repositories were reported not wired while the modules holding their clustering were skipped for packages the graded run installs (`python/cogbench/src/cogbench/verdict.py:420`).

The sentence names a count and no cause, because the skips do not share one (`verdict.py:457`):

> "This check could not read {one of your files | n of your files}, so it could not finish looking for the code this task needs."

Every skipped module carries an owner (`python/cogbench/src/cogbench/discover.py:281`; `verdict.py:202`):

| Owner | What it means now | Does a verdict stand? |
| --- | --- | --- |
| `ours` | A dependency would not import, or no available name could read the file. | No. The run refuses to judge. |
| `environment` | Found only in older records; no current search writes it. | No, for the same reason. |
| `theirs` | A syntax error, a module that raises on import, or one too slow to import. | Yes. |

The run page prints the owner beside a skipped module's reason only when it is not `theirs`, as "(ours)" or "(environment)" (`RefusalCard.tsx:176`).

### Withheld

A number that exists in principle but was not measured, so it is not reported and never drawn as zero.

Week 3 is where this happens. When the image side never bound, its retrieval cases never ran, and an overall averaged over them is a number nobody measured; `overall` and the retrieval scores are dropped and `text_mrr` becomes the primary. When the image side bound and the database or search function did not, `overall` and the search scores are dropped and `retrieval_mrr` becomes the primary. Floors stay, and a floor whose score was dropped keeps its own row. The first note says what was withheld and why, beginning `overall withheld: `. The exact sentences are in [`../sandbox/scoring-and-refusals.md`](../sandbox/scoring-and-refusals.md#week-3-withholds-the-overall).

The measured reason: one team's first end-to-end run scored search 0.0 into an overall of 0.4183 with its prepare step bound to the wrong argument order, and an independent review found a median rank published at 100.0 from retrieval cases that never ran (`benchmarks/week3/language_search_benchmark/plugins.py:574`, pinned `94c7e64`).

A run with no primary at all says so: "This run has no overall score. Everything the scorer could measure is below." (`apps/portal/src/routes/RunDetailPage.tsx:579`).

### Floor

A number that belongs to the dataset rather than the submission: what a trivial baseline or chance scores. It is drawn on the row of the metric it belongs to, as `floor 0.010`, with no arrow, because "higher is better" on a floor is advice to raise a number the student does not control (`apps/portal/src/components/MetricBlock.tsx:257`).

Every scored metric may carry an arrow saying which direction is better, and that arrow is an assertion about the submission. The roles a benchmark can declare are `scored`, `floor`, `reported` (run on purpose and kept out of the score, tagged "not scored"), `diagnostic` (grouped last) and `plotted` (read off the curve). A run whose metrics declare no roles at all gets no arrows anywhere, because the page cannot tell its floors from its scores without guessing (`MetricBlock.tsx:53`). Week 2 declares none.

### Supplied by the benchmark

Anything the platform handed the team's code that did not come out of it: the name of each item, a GloVe table, a folder, an id-to-name table over the enrolled songs. A score computed with a resource the platform provided is a different claim from one computed without it.

Almost nobody sees it. The phrase is built during discovery and reaches the JSON that `cogworks check --json` prints and the sandbox's own discovery file. Plain `cogworks check`, `cogworks report`, the run page and Discord do not show it, and nothing on the wire from the sandbox to the portal carries it. The one supplied thing a run page does name is the team's own synced weights: "{paths} from your local run at {shortSha}" (`RunDetailPage.tsx:179`). See [`../cross-cutting/what-the-benchmark-supplied.md`](../cross-cutting/what-the-benchmark-supplied.md).

### Simulated

When the portal's execution provider is the fixture rather than Modal, every run page carries a "Simulated" chip with the title "Execution provider is in fixture mode. Results are scripted, not real evaluation." (`apps/portal/src/components/SimulatedChip.tsx:13`), and Discord's run line adds "simulated". This is a development setting; a student on the hosted portal does not see it.

### No per-person numbers

The rule is that no number is attributed to an individual, in any form, including privately. A seventeen-year-old reads any per-person number as a grade regardless of the caveats.

Parts of the code enforce it. A test fails the build on a field shaped like one (`python/cogbench/tests/test_process.py:10`), and the team nudges are written to the same rule (`apps/portal/worker/services/team-nudges.ts`). The local reports table dropped its author column for the same reason. Three places break the rule today by printing a login beside a score: Discord's local view leads each line with the author's login in bold before the result (`apps/discord-bot/src/commands.ts:373`), the run bubble puts "by {name}" on the line under the score in its heading (`discord-messages.ts:142`), and the live run surface shows "@{login}" beside the primary metric (`apps/portal/src/components/RunConsole.tsx:324`). See the open questions.

## The five verdicts

Discovery reaches one of five conclusions about a repository, plus the refusal above. Each calls for something different, so collapsing them into "it failed" would throw away what the student needs.

| Verdict | What it means | Whose problem |
| --- | --- | --- |
| `scored` | The code ran and produced a number. A low number is a result. | Nobody's. It is a measurement. |
| `wired_but_wrong` | The pipeline ran end to end and answered wrong on a case the benchmark knows the answer to. | Theirs, said plainly. |
| `not_wired` | No chain of their functions performs the task. The headline names the hand-off that failed. | Shared. |
| `not_read` | The code could not be imported, or the interpreter died trying. | Named module, named reason. |
| `nothing_here` | There is no Python in the repository yet. | Said plainly. |

`wired_but_wrong` states the case and both answers and stops, then adds one note: "Your code ran end to end. On {task}, it answered {got} where the answer is {expected}." and "The benchmark passed each step above the input it asked for and passed its result to the next." (`verdict.py:386`). No guess at a cause; the wiring trace beneath it is the smallest failing reproduction the platform has.

## Modifiers

| Modifier | Set before the ask | Changed while it works |
| --- | --- | --- |
| Who you are | No effect on the vocabulary. An instructor reading a team's run sees the same words. No view reveals a withheld number. | No effect. |
| Where your team and repository stand | Decides which verdict or refusal is reached, and whether Week 3 withholds. | No effect within one run. |
| Which week's benchmark | Week 3 is the only benchmark that withholds. Week 2 declares no metric roles, so its rows carry no arrows. Week 1 is the only one whose driver reads a `PROVENANCE` declaration. | No effect. |
| Practice or leaderboard | A self-reported number can never be promoted. A refused run has no number to promote. A withheld Week 3 run can be promoted and published with its substitute primary. | No effect. |
| Flags, options, and where you are typing | The terminal prints the most verdict text; the run page shows the evidence; the live surface and Discord show the refusal headline, Discord cut at 300 characters (`discord-messages.ts:233`). | No effect. |

## Cancel and interrupt

| Event | Before the work begins | While it works |
| --- | --- | --- |
| You stop it yourself | No claim has been made. | A local command stopped with Ctrl+C makes no claim. A hosted run has no cancel control. |
| You do something else mid-way | No effect. | No effect on the vocabulary. |
| A teammate acts at the same time | No effect. | No effect. Claims are about one run at one commit. A teammate's check-off or `cogworks check --update-setup` can tick a shared setup step while the page is open. |
| The network or the portal fails | No claim. | A run the portal stops hearing from is failed after an hour as "The execution provider stopped reporting progress." (`apps/portal/worker/execution/maintenance.ts:34`). A result that arrives later is kept as history on that failed run under "Recorded before it stopped" and never shown as a success. |
| The page or the process goes away | No claim. | A run killed at the container level is attributed by elapsed time and return code, never by reading text the student could have written. See [`../sandbox/timeouts-and-limits.md`](../sandbox/timeouts-and-limits.md). |
| The thing being measured changes | No effect. | No effect. A run's claims are about the commit it resolved at the start. |
| The platform refuses or credit runs out | An exhausted quota is refused before any work, and the sentence says which quota. | Not reachable. |

## Interactions with other systems

**Who may do this.** The vocabulary is not role-scoped. Nobody sees a stronger claim than anybody else.

**The team owns it.** Every claim is about a team's repository at a commit. The places that still put a login beside a score are listed above.

**Credit.** Failed executions use no quota whatever their attribution. See [credit and quota](../cross-cutting/credit-and-quota.md).

**What the benchmark supplied.** Defined above, detailed in [`../cross-cutting/what-the-benchmark-supplied.md`](../cross-cutting/what-the-benchmark-supplied.md).

**Live updates and reconnection.** The live stream carries phase names. No number is shown until the run settles.

**Discord.** The bubble carries the primary metric, up to four others, and at a failure up to 300 characters of a refusal headline. It is the most truncated view of any claim the platform makes.

**Configuration.** None of this vocabulary is configurable. The fixture provider that produces "Simulated" is a deployment setting.

## Edge cases

- **A `scored` run can still be wrong for the repository.** If a team's best implementation sits in a module that failed to import, the search binds a weaker candidate and publishes a real number. Only the coverage record says so, and only `cogworks check --json` shows it (`verdict.py:170`).
- **A failure can be attributed to the team for the platform's own fault.** Student code and the platform's SDK run in one process during evaluation, so an exception raised inside `cogbench` is reported as `E-RUNTIME`, "Your code raised an exception" (`packages/contracts/src/failures.ts:89`). `2ff32fa` still has such a crash at `python/cogbench/src/cogbench/pipeline.py:834`, reached when a Week 2 describe step returns `None` for a photo with no face.
- **A withheld primary is compared as if it were the overall.** The Runs list heads its reading column with the first run's primary label (`apps/portal/src/components/RunList.tsx:40`), the leaderboard sorts every entry by its own primary value (`apps/portal/worker/services/leaderboard.ts:108`), and Discord's team best takes the highest primary of any key (`apps/portal/worker/services/run-surfaces.ts:198`). The run page itself compares only the same key.
- **Descriptions of values are stable.** Shapes come before contents ("a list of 5158 pairs") and memory addresses are stripped (`verdict.py:83`, `:93`), so two runs of the same repository produce identical text.
- **The gap note and `could_not_look` overlap.** `cogworks check` drops its paragraph about missing graded packages when the verdict already says it could not look (`python/cogbench/src/cogbench/report.py:244`).

## Open questions and verification

- "Verified" on the setup page means a CLI report from a linked device, which originates on the student's machine. The glossary says anything on a student's machine is never called verified. Either the glossary narrows "verified" to "observed by the portal, including reports from the CLI's own checks", or the setup page renames its strongest tick. Product call, carried as B-63; the glossary records the current use.
- Discord's local view, the run bubble and the live surface put a login beside a score, while the Runs page removed its author column on the stated ground that a name beside a score reads as a grade. Carried to triage. **Unverified** in Discord.
- The supplied disclosure does not reach the hosted run page. [B-04](../bug-triage.md).
- A withheld Week 3 primary is listed under "Overall", ranked on the leaderboard, and counted as a Discord team best. Carried to triage. **Unverified** against a real withheld run.
- `E-RUNTIME` "Your code raised an exception" is shown for an exception raised in the platform's own SDK. Observed hosted on beta, run `run_f5fc5babe5`, before beta's fix; the same crash is present in `2ff32fa` (`pipeline.py:834`). Carried to triage.
- The Discord 300-character cut is tested only by a tautology (`apps/discord-bot/test/refusal-message.test.ts:16`). [B-38](../bug-triage.md).
- Floors render without an arrow: observed locally on fixture data at `2ff32fa` (`final-2ff32fa/result-detail.txt`: "Retrieval MRR / floor 0.010 / 0.212 / higher is better", the direction belonging to the score). A withheld run's orphan floors were not observed.
- **Hosted beta (`4984730`) differs:** beta's Runs list has no reading-column heading, so the "Overall" mislabel is candidate-only (beta `apps/portal/src/components/RunList.tsx:31` against `2ff32fa` `RunList.tsx:40`), and beta keeps the per-item `None` fix that `2ff32fa` lacks (beta `468655c`, `python/cogbench/src/cogbench/pipeline.py:834` on `2ff32fa`).
- Local `17d26d9` differs on the withheld primary: publication and the board use the catalog's ranked measure, and a run without it is refused. That refusal was observed on the local fixture build with a synthetic partial result ([checkpoint](../verification/checkpoint-17d26d9.md)). The Runs list heading and Discord's team best changed in `17d26d9` source and were not observed. The per-person login on the console (`RunConsole.tsx:357` at `17d26d9`) is unchanged.
- Integrated `93dfa5e` source differs on per-person numbers: the console, Discord's local view and the run bubble no longer print a login beside a score ([B-64](../bug-triage.md#b-64-discord-and-the-console-put-a-students-login-beside-a-score)). Read from code; not seen in Discord.

Read against Cog\*Portal commit `2ff32fa`.
