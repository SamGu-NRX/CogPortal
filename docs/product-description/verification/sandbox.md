# Verification: the sandbox and the cross-cutting concerns

How to run this file: the sandbox has no interface of its own, so every item here is observed through the run page, the failure card, or the live console. Start hosted runs from the dev portal against repositories you have prepared to produce each outcome. Several items need a repository built to fail in a specific way; the Setup column names what that repository has to do, and preparing them is most of the work in this file.

Two documents describe work that was in flight during drafting. Re-read `apps/runner-modal/src/cogworks_runner/modal_app.py` and `benchmarks/adapters/` before running `PREP-*`, and `benchmarks/week3/language_search_benchmark/plugins.py` and `roles.py` before running `SCORE-*`.

Budget for this file. A hosted run takes minutes and the practice quota is ten per team per benchmark, so a full pass needs several teams or a raised limit. Plan which repository produces which outcome before starting.

## sandbox/prepare.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PREP-01 | P1 | none | The phases arrive in order and the rail follows them ([the phases](../sandbox/prepare.md)). | Any working repository. | 1. Start a practice run and watch the rail. | Queued, Prepare, Install, Contract check, Evaluate, Score, Complete, in that order, each with a timing. | not run |
| PREP-02 | P1 | none | An official run skips prepare and install ([Modifiers](../sandbox/prepare.md)). | A promoted run reusing a prepared artifact. | 1. Watch its rail from the start. | It begins at the contract check. Record what the two skipped nodes look like; the document flags them appearing complete as a suspected slip. | not run |
| PREP-03 | P1 | none | A repository with nothing scoreable gets a refusal, not a failure message ([the refusal](../sandbox/prepare.md)). | A repository with no adapter and nothing discovery can bind. | 1. Start a run and read the page. | The refusal card headed "WHAT THE BENCHMARK LOOKED FOR", carrying the verdict headline. No stack trace, no scorer vocabulary. | not run |
| PREP-04 | P1 | none | No prepare failure ever spends an official attempt ([Interactions](../sandbox/prepare.md)). | An official run against a repository that fails during prepare. | 1. Promote and let it fail.<br>2. Read the failure card and the dashboard counter. | "No official attempt was consumed." and the counter is unchanged. | not run |
| PREP-05 | P1 | none | A repository too large to fetch is refused by the archive check ([the archive](../sandbox/prepare.md)). | A repository whose archive exceeds 100 MiB. | 1. Start a run. | A repository-fetch failure, not a dependency-install one. Record which category the card names. | not run |
| PREP-06 | P2 | none | A broken `requirements.txt` is a warning, not a failure ([the install](../sandbox/prepare.md)). | A repository with an unsatisfiable requirements file and an otherwise working submission. | 1. Start a run. | The run proceeds to scoring. Any note about the requirements file is informational. | not run |
| PREP-07 | P2 | none | The error line names the reader's problem, not our script ([How it ends](../sandbox/prepare.md)). | A repository whose prepare raises. | 1. Read the failure detail. | A sentence, not a traceback frame, and no reference to a file under `/tmp`. | not run |
| PREP-08 | P1 | week 3 | An uploaded weight file reaches the sandbox ([the weights](../sandbox/prepare.md)). | A Week 3 repository whose weights are untracked, synced from a local run at the same commit. | 1. Start a hosted run at that commit. | The image side binds and the overall is not withheld. Compare with a run at a different commit, which should be withheld. | not run |
| PREP-09 | P1 | week 3 | Weights do not follow a new commit (suspected bug) ([Edge cases](../sandbox/prepare.md)). | Same, then one further commit pushed. | 1. Start a hosted run at the new commit. | Record what happens and whether anything explains it. The document expects a withheld overall with no message about the commit. | not run |
| PREP-10 | P2 | none | Instructor adapters are gone ([In flight](../sandbox/prepare.md)). | Any repository. | 1. Search a finished run's diagnostics for any mention of a supplied adapter. | None. Confirm `benchmarks/adapters/` is absent from the tree at the commit under test. | not run |

Not checkable by hand:

- The hash-seed defect needs two runs of a repository whose result depends on iteration order, and the difference may not appear on any given pair. It is scriptable: run the same commit five times and compare, which is the only practical check.
- The module-level wiring state needs two runs to overlap in one Modal container, which cannot be arranged from outside.

## sandbox/discovery.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DISC-01 | P1 | none | The trace names the team's own functions ([the wiring trace](../sandbox/discovery.md)). | A repository whose chain binds. | 1. Read the trace on the run page. | Each row names `module.function` as it appears in the repository, with what it took and returned. | not run |
| DISC-02 | P1 | none | A declared submission wins over discovery ([Asking](../sandbox/discovery.md)). | A repository with a root `submission.py` and other bindable functions. | 1. Start a run and read the trace. | The declared file is used; no search happened. | not run |
| DISC-03 | P1 | none | A pipeline that runs and answers wrong is reported as theirs ([the verdicts](../sandbox/discovery.md)). | A repository whose chain binds and returns a wrong answer on a known case. | 1. Read the finding. | It states the case and both answers and stops. No guess at a cause. | not run |
| DISC-04 | P1 | none | A hand-off failure names the hand-off, not the task ([the verdicts](../sandbox/discovery.md)). | A repository whose stages do not fit together. | 1. Read the headline. | It names the function whose output nothing accepted, and what it returned. | not run |
| DISC-05 | P1 | none | The trace is capped at sixteen steps ([Edge cases](../sandbox/discovery.md)). | A repository with a long chain. | 1. Count the rows. | At most sixteen, and the heading says the trace is incomplete when it is. | not run |
| DISC-06 | P2 | none | The second search in the evaluate sandbox can disagree with the first ([Edge cases](../sandbox/discovery.md)). | A repository whose binding is unstable. | 1. Look for the sentence about functions that could not be found again. | Record whether it ever appears. | not run |
| DISC-07 | P1 | none | The supplied disclosure is absent from the run page (suspected bug) ([Interactions](../sandbox/discovery.md)). | A Week 3 repository that binds with benchmark-supplied resources. | 1. Run `cogworks check --benchmark language-search --json` and read the supplied entries.<br>2. Read the hosted run page for the same commit. | Record both. The document expects the terminal JSON to carry it and the run page to have nothing. | not run |

## sandbox/scoring-and-refusals.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SCORE-01 | P1 | week 3 | The withheld sentence leads the page ([Week 3 withholds the overall](../sandbox/scoring-and-refusals.md)). | A Week 3 repository with no trained weights. | 1. Read the run page top to bottom. | The withheld sentence is the finding, above the metrics. | not run |
| SCORE-02 | P1 | week 3 | The withheld sentence is cut off (suspected bug) ([Week 3 withholds the overall](../sandbox/scoring-and-refusals.md)). | Same. | 1. Copy the sentence and count its characters. | Record both. The document expects it to stop around 240 characters, mid-word. | not run |
| SCORE-03 | P1 | week 3 | No withheld number is rendered as zero ([the withheld rule](../sandbox/scoring-and-refusals.md)). | Same. | 1. Read every metric row. | No `overall`, no zeroed retrieval or search scores, and the primary is `text_mrr`. | not run |
| SCORE-04 | P1 | week 3 | Weights found but unbound gets its own sentence ([Week 3 withholds the overall](../sandbox/scoring-and-refusals.md)). | A Week 3 repository with committed weights and no function that uses them. | 1. Read the finding. | It names where the weights were read from and what did not bind, rather than saying there are no weights. | not run |
| SCORE-05 | P1 | none | A result count mismatch is explained in the student's terms ([the prediction check](../sandbox/scoring-and-refusals.md)). | A repository whose adapter returns fewer results than cases. | 1. Read the failure detail. | The sentence naming both counts and suggesting a skipped case or a filter. | not run |
| SCORE-06 | P1 | none | A non-finite number is caught before scoring ([the prediction check](../sandbox/scoring-and-refusals.md)). | A repository that returns a NaN. | 1. Read the failure detail. | The sentence naming the value and pointing at a division by zero or an average over an empty list. | not run |
| SCORE-07 | P1 | none | An invalid output spends an official attempt ([Interactions](../sandbox/scoring-and-refusals.md)). | An official run whose output is invalid. | 1. Read the failure card and the counter. | "This failure consumed one official attempt." and the counter moves. | not run |
| SCORE-08 | P2 | none | A floor renders without an arrow ([the metrics](../sandbox/scoring-and-refusals.md)). | Any run with a floor. | 1. Find the floor. | Inline under its metric, no arrow. | not run |
| SCORE-09 | P2 | week 3 | A withheld metric's floor disappears (suspected bug) ([the metrics](../sandbox/scoring-and-refusals.md)). | A Week 3 withheld run. | 1. Look for the floors of the withheld scores. | Record whether any is visible. | not run |
| SCORE-10 | P2 | none | A plugin mismatch is reported as a data problem (suspected bug) ([Cancel and interrupt](../sandbox/scoring-and-refusals.md)). | A deployed plugin whose version disagrees with the run job. | 1. Read the failure card. | Record the code and title. The document expects the data-not-ready copy for a version problem. | not run |

## sandbox/timeouts-and-limits.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LIMIT-01 | P1 | week 3 | A run past the ceiling is called a timeout, with advice ([the attribution](../sandbox/timeouts-and-limits.md)). | A Week 1 or Week 3 repository that exceeds 900 seconds. | 1. Read the failure card. | A timeout, with the message about work that grows with the catalog. Record the elapsed time. | not run |
| LIMIT-02 | P1 | none | Week 2 does not attribute a timeout (suspected bug) ([the attribution](../sandbox/timeouts-and-limits.md)). | A Week 2 repository that exceeds 900 seconds. | 1. Read the failure card. | Record the category and the detail. The document expects a generic runtime failure with a stderr fragment. | not run |
| LIMIT-03 | P1 | week 3 | The Week 3 timeout message talks about songs (suspected bug) ([the attribution](../sandbox/timeouts-and-limits.md)). | A `language-search` timeout. | 1. Read the message. | Record it verbatim. The document expects Week 1's copy about enrolling songs. | not run |
| LIMIT-04 | P1 | none | A memory failure is attributed to the team and spends the attempt ([the attribution](../sandbox/timeouts-and-limits.md)). | An official run that exhausts its memory. | 1. Read the card and the counter. | A memory-limit failure, "This failure consumed one official attempt.", and the counter moves. | not run |
| LIMIT-05 | P1 | none | Nothing a submission writes can change who owns a failure ([the attribution](../sandbox/timeouts-and-limits.md)). | A repository that writes `COG_PLATFORM_ERROR:` to file descriptor 2 and then fails. | 1. Start an official run and read the card and the counter. | The failure is attributed to the team and the attempt is spent. The marker changes nothing. | not run |
| LIMIT-06 | P2 | none | The student log is capped and the cap is visible ([the limits](../sandbox/timeouts-and-limits.md)). | A practice run that prints far more than 8 KiB. | 1. Expand the log. | It stops at the cap rather than growing without bound. | not run |
| LIMIT-07 | P2 | none | An official run has no log at all ([Modifiers](../sandbox/timeouts-and-limits.md)). | Any official run. | 1. Look for a log. | None, and the page says the evaluation is hidden. | not run |
| LIMIT-08 | P3 | none | A stalled run is failed by the reaper, not left forever ([Cancel and interrupt](../sandbox/timeouts-and-limits.md)). | A run whose provider stops reporting. | 1. Wait past the reaper threshold. | It reaches a failed state with a provider category, and the attempt is refunded. Record how long it took; the document notes the window can approach 45 minutes. | not run |

## The cross-cutting documents

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CROSS-01 | P1 | discord | The four surfaces show four different amounts of one refusal ([the comparison](../cross-cutting/refusals-and-disclosure.md)). | One repository that produces a refusal. | 1. Read it in `cogworks check`, on the run page, in the Discord bubble, and in the activity. | Record all four. The document expects the terminal to be fullest and Discord to be a truncated single line. | not run |
| CROSS-02 | P1 | none | The refusal headline appears twice on one page (suspected slip) ([the comparison](../cross-cutting/refusals-and-disclosure.md)). | A refused run. | 1. Read the failure card and the refusal card together. | Record whether the same sentence is in both. | not run |
| CROSS-03 | P1 | none | A run page's live region announces the reason, not just the status (suspected gap) ([Interactions](../cross-cutting/refusals-and-disclosure.md)). | A failing run, with a screen reader. | 1. Listen to what is announced when the run settles. | Record it. The document expects the status word alone. | not run |
| CROSS-04 | P1 | device | Every polling interval is what the documents say ([the intervals](../cross-cutting/live-updates.md)). | The run page, the connections page, and the setup page, each in its polling state. | 1. Record request timings in the network panel for one minute each. | 2 s, 4 s, and 2.5 s respectively. | not run |
| CROSS-05 | P1 | device | The connections poll never stops ([the intervals](../cross-cutting/live-updates.md)). | No devices linked. | 1. Leave `/connections` open for ten minutes. | Record whether the requests ever stop or slow. | not run |
| CROSS-06 | P1 | device | A long run drops its earliest events (suspected gap) ([the event cap](../cross-cutting/live-updates.md)). | A run producing more than 250 events. | 1. Open the live console and scroll to the top. | Record whether the first events are present and whether anything marks the truncation. | not run |
| CROSS-07 | P2 | device | The replay batch fills in what was dropped ([the replay](../cross-cutting/live-updates.md)). | A `--live` run over a flaky connection. | 1. Compare the console's event list during and after the run. | The list is complete once the run finishes. | not run |
| CROSS-08 | P1 | none | The supplied disclosure exists in one place only ([the disclosure](../cross-cutting/what-the-benchmark-supplied.md)). | Any repository that binds with supplied resources. | 1. Look for it in `cogworks check` text output, `--json`, `cogworks report`, and the run page. | Record all four. The document expects it only in `--json`. | not run |
| CROSS-09 | P2 | none | The instructor-adapter disclosure is now unreachable ([the disclosure](../cross-cutting/what-the-benchmark-supplied.md)). | Any run. | 1. Search finished runs for the supplied-adapter sentence. | None, because nothing writes the provenance it depends on. | not run |

Not checkable by hand:

- Whether a refusal's status is worth surfacing on the run page. That is a design question the document raises rather than an observation.
- The exact per-week package lists, which are data rather than behavior and are settled by the tests that compare them against the images.
