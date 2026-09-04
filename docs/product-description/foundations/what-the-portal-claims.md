# What the portal claims

## Summary

The platform has a rule about its own honesty: it only says what it observed. That rule produces a small vocabulary (*verified*, *self-reported*, *refused*, *could not look*, *withheld*, *floor*, *supplied*) and this document owns every one of those words. Other documents use them and link here.

The rule exists because of what this platform is for. It is an instrument that reports findings, not a judge that issues grades (`docs/design/the-instrument-not-the-judge.md`). An instrument that reports a number it did not measure is broken in a way that a low number is not.

There is no screen called "what the portal claims". The words appear as chips, headlines, diagnostics, and the words `LOCAL · SELF-REPORTED` on a terminal report.

## The simple case

A student runs the benchmark on their own laptop and gets `0.6412`. They sync it. It appears in the portal under their name, marked self-reported, and it can never reach the leaderboard. Then they start a hosted run on the same commit. The portal runs the code itself, gets its own number, and that number is eligible for promotion. The two are never mixed and never compared as though they were the same kind of claim.

Somewhere in between, the platform sometimes has to say it does not know. It says so as a sentence with a reason, not as a zero and not as an error.

## The vocabulary

### Verified

The portal observed it for itself. Used only for facts the portal saw: a hosted run's metrics, a device approval, a setup step the portal checked. Anything on a student's machine is theirs to confirm and is never called verified.

The setup page makes the distinction visible in its per-step chips: `portal verified` for something the portal checked, `CLI checked` for something the CLI reported, `linked` for a connection, and `self checked` for a box the student ticked themselves (`apps/portal/src/routes/SetupPage.tsx`). Four different words for four different strengths of claim, on one screen.

### Self-reported

A result the student's own machine produced. Shown as `LOCAL · SELF-REPORTED` on the first line of every local report the CLI prints, and as `-# self-reported, never leaderboard-eligible` under the Discord local-notes view (`apps/discord-bot/src/commands.ts:348`). `cogworks sync` prints "Synced {report_id} as LOCAL · SELF-REPORTED."

A self-reported number is not distrusted; it is differently sourced, and the platform refuses to let the difference blur. The dashboard says so in its empty state: "No team member has explicitly synced a CogBench report for this benchmark." The word *explicitly* is doing work. Nothing is uploaded in the background.

> Technical note: `sync_report` strips `outputDigest` from the payload before sending (`python/cogbench/src/cogbench/client.py:88`). The digest is a hash of the predictions, and it stays on the student's machine. The portal receives metrics and diagnostics, not evidence it could re-verify, which is the honest shape for a claim it is going to label self-reported anyway.

### Refusal

The platform declining to give a number, stated as a sentence with a reason. A refusal is not a failure and not a zero.

The structured refusal object reaches the run page only from one place: the `adapter_missing` branch of the prepare stage (`apps/runner-modal/src/cogworks_runner/modal_app.py:1186`). It carries a status, a headline capped at 600 characters, a next step capped at 600, and a trace capped at 16 steps. The run page renders it under the panel heading "WHAT THE BENCHMARK LOOKED FOR" (`apps/portal/src/components/RefusalCard.tsx`).

The next step is present only when the platform honestly knows one. For a bug in the team's own code it is absent, because which line is wrong is theirs to find and a confident wrong explanation costs more than none.

### Could not look

The specific refusal for when the platform manufactured the absence. A module was skipped for a reason that belongs to the platform rather than the repository, so no verdict about the repository is supported.

This is the sharpest edge in the vocabulary. "We looked and found nothing" is a claim about the repository. "We could not look" is a claim about the platform. Reporting the first when the second is true is the failure this status exists to prevent, and it was a real one: three Week 2 repositories were reported not wired while the modules holding their clustering were skipped for packages the graded run installs (`python/cogbench/src/cogbench/verdict.py:340`).

The sentence names the count and assigns the blame outward:

> "This check could not read {n} of your files, because this machine is missing packages they import. That is a limit of this check and not a problem with your repository: the graded run installs those packages and will read them."

The count stays and the module names do not, because the next step lists them and printing both made the reader compare two lists to discover they were the same list.

Every skipped module carries an owner, and the owner decides what may be said afterwards:

| Owner | What it means | Does a verdict stand? |
| --- | --- | --- |
| `ours` | A package the graded run installs but this machine lacks, or a loader defect. | No. `read_enough_to_judge` is false and the run refuses to judge. |
| `environment` | A package genuinely absent from the graded run too. | Yes, and the skip is worth naming, because the graded run will fail the same way. |
| `theirs` | A syntax error, or a module that raises on import. | Yes, and the attribution is now true. |

### Withheld

A number that exists in principle but was not measured, so it is not reported. A withheld number is never rendered as zero.

Week 3 is where this happens. When a repository's image side never bound (no trained weights, or weights that nothing turned into vectors), the retrieval and search cases never ran. The driver would score those as zero, and an overall averaged over them is a number nobody measured. So the three image-side scores and the overall are dropped, their floors are kept, the primary metric becomes `text_mrr`, and a diagnostic naming the team's own save path is inserted first (`benchmarks/week3/language_search_benchmark/plugins.py:336`).

The four sentences, all beginning `overall withheld: `, are listed in [`../sandbox/scoring-and-refusals.md`](../sandbox/scoring-and-refusals.md#week-3-withholds-the-overall).

The measured reason this matters: one team's first end-to-end run scored search 0.0 into an overall of 0.4183 with its prepare step bound to the wrong argument order. Another had a median rank published at 100.0 from retrieval cases that never ran.

### Floor

A number that is a property of the dataset rather than of the submission: what a trivial baseline scores. A floor is drawn as the scale its metric sits on, with no arrow, because "higher is better" on a floor reads as advice to raise a number the student does not control.

Every metric renders with an arrow saying which direction is better, and that arrow is an assertion about the submission. Week 3 publishes three floors and drew the arrow on all of them until `metric_roles` gave a benchmark a way to say otherwise. The roles are `scored`, `floor`, `reported`, and `diagnostic`; a metric that declares none renders as everything did before, which keeps older plugins working.

### Supplied by the benchmark

Anything the platform handed the team's code that did not come out of it: the name of each item, a GloVe table, a folder, an id-to-name table over the enrolled songs. A score computed with a resource the platform provided is a different claim from one computed without it.

Almost nobody sees it. The phrase is built during discovery and reaches exactly two places: the JSON that `cogworks check --json` prints, and the sandbox's internal discovery file. `render_check` does not print it, `cogworks report` does not print it, and nothing on the wire between the sandbox and the portal carries it, so no run page can show it either. The comment at `python/cogbench/src/cogbench/resolve.py:271` says "A run page shows this under 'supplied'", and no run page does. Carried to triage.

### No per-person numbers

The hardest rule. No number is attributed to an individual, in any form, including privately. A seventeen-year-old reads any per-person number as a grade regardless of the caveats.

It is enforced rather than intended: a test fails the build on a field shaped like one (`python/cogbench/tests/test_process.py`). The team nudges are written to the same rule and never name a person or count per person (`apps/portal/worker/services/team-nudges.ts:1`).

## The five verdicts

Discovery reaches one of five conclusions about a repository, plus the refusal above. Each calls for something different, so collapsing them into "it failed" would throw away the only information the student needs.

| Verdict | What it means | Whose problem |
| --- | --- | --- |
| `scored` | The code ran and produced a number. A low number is a result. | Nobody's. It is a measurement. |
| `wired_but_wrong` | The pipeline ran end to end and answered wrong on a case the benchmark knows the answer to. | Theirs, and the platform says so plainly, which is more respectful of their work than implying the platform failed. |
| `not_wired` | No chain of their functions performs the task. The headline names the hand-off that failed. | Shared. Often the platform's to explain. |
| `not_read` | The code could not be imported, or the interpreter died trying. | Named module, named reason. |
| `nothing_here` | There is no Python in the repository yet. | Rare, and said plainly rather than dressed up as a failure. |

`wired_but_wrong` is the finding the whole platform exists to produce, and the one a scoreboard cannot express. Its headline states the case and both answers and stops:

> "Your code ran end to end. On {task}, it answered {got} where the answer is {expected}."

No guess at a cause. A system that cannot read their code cannot know whether the fanout is too narrow or the database key is wrong. What makes it actionable is the wiring trace beneath it, which is the smallest failing reproduction the platform has.

## Modifiers

| Modifier | Set before the ask | Changed while it works |
| --- | --- | --- |
| Who you are | No effect on the vocabulary. An instructor reading a team's run sees the same words a student does. There is no privileged view that reveals a withheld number. | No effect. |
| Where your team and repository stand | A repository with nothing in it gets `nothing_here`; one whose modules will not import gets `not_read`. The vocabulary is the same, the verdict differs. | No effect within one run. |
| Which week's benchmark | Week 3 is the only benchmark that withholds. Week 1 and Week 2 either score or fail. Week 1 is the only one that can disclose an instructor-supplied adapter. | No effect. |
| Practice or leaderboard | A self-reported number can never be promoted. A refused or withheld run has no number to promote. | No effect. |
| Flags, options, and where you are typing | The terminal prints the full verdict text; the run page renders the same facts as cards; Discord truncates a refusal headline to 300 characters (`apps/portal/worker/services/discord-messages.ts:219`). The three surfaces do not say the same amount. | No effect. |

## Cancel and interrupt

| Event | Before the work begins | While it works |
| --- | --- | --- |
| You stop it yourself | No claim has been made, so there is nothing to retract. | A run stopped part way produces a failure, not a refusal. The distinction holds: a failure says something went wrong; a refusal says nothing went wrong and here is why there is no number. |
| You do something else mid-way | No effect. | No effect on the vocabulary. |
| A teammate acts at the same time | No effect. | No effect. Claims are about a run, and a run is about one commit. |
| The portal fails | No claim. | A failure whose category is marked `infrastructure` is the platform's, and the platform pays for it with a refund. That flag is the credit system's version of the same honesty rule. |
| The process goes away | No claim. | A run killed at the container level is attributed by elapsed time and signal, never by reading text the student could have written. See [`../sandbox/timeouts-and-limits.md`](../sandbox/timeouts-and-limits.md). |
| The thing being measured changes | No effect. | No effect. A run's claims are about the commit it resolved at the start. |
| Refused, or out of credit | An exhausted quota is refused before any work, and the sentence says which quota. | Not reachable; credit is checked before work begins. |

## Interactions with other systems

**Who may do this.** The vocabulary is not role-scoped. Nobody sees a stronger claim than anybody else.

**The team owns it.** Every claim is about a team's repository at a commit. The one claim about a person is the GitHub login on a synced local report, which names who ran it, not how they did.

**Credit.** The `infrastructure` flag on a failure decides whether the team pays. See [`../cross-cutting/credit-and-quota.md`](../cross-cutting/credit-and-quota.md).

**What the benchmark supplied.** Defined above, and detailed in [`../cross-cutting/what-the-benchmark-supplied.md`](../cross-cutting/what-the-benchmark-supplied.md).

**Live updates and reconnection.** A live event stream carries phase names, not claims. No number is shown until the run settles.

**Discord.** The bubble carries a metric and, at terminal, up to 300 characters of a refusal headline. It is the most truncated view of any claim the platform makes.

**Configuration.** None of this vocabulary is configurable.

## Edge cases

- **A `scored` run can still be wrong for the repository.** If a team's best implementation sits in a module that failed to import, the search binds a weaker candidate from what is left and publishes a real number that is wrong for that repository. No verdict describes that. Only the coverage does, which is why coverage travels with every verdict rather than only with failures (`python/cogbench/src/cogbench/verdict.py:148`).
- **The gap note and the refusal say overlapping things.** `cogworks check` prints a paragraph naming graded packages this machine lacks, and separately can produce a `could_not_look` verdict about the same packages. When the verdict covers it, the paragraph is suppressed, because printing both made the reader work out that two paragraphs were one fact. The verdict wins, being specific about which modules.
- **A description of a value is deliberately stable.** Shapes are reported before contents ("a list of 5158 pairs", "an array of shape (1025, 171)"), and memory addresses are stripped, so two runs of the same repository produce identical bytes. An array preview is almost always noise; what a reader checks is whether the shape is the one their next function expects.
- **The terminal and the run page disagree about "supplied".** The terminal shows it. The run page does not, though a code comment says it does. Carried to triage.

## Open questions and verification

- The `supplied` disclosure not reaching the hosted run page looks like a real gap rather than a decision: the comment at `python/cogbench/src/cogbench/resolve.py:271` asserts behavior the wire contract does not implement. Worth treating as a bug. **Unverified** against a live run page.
- Whether a student can tell a floor from a score at a glance on the run page was not observed. The renderer draws floors inline as `floor 0.42` under the metric they belong to, which reads correctly in the source, but no screenshot was taken. **Unverified.**
- The Discord 300-character truncation of a refusal headline is untested: `apps/discord-bot/test/refusal-message.test.ts:16` asserts `headline.slice(0, 300).length <= 300` on a string literal defined in the test itself, which is a tautology. Carried to triage.
- Whether `LOCAL · SELF-REPORTED` appears anywhere in the browser with that exact wording was not confirmed; the dashboard's local-report section was read but its per-row rendering was not.

Verified against Cog\*Portal commit `f74e087`.
