# Glossary

The vocabulary used across these documents. When a document uses one of these words, it means exactly this. A document that uses a term of art this file does not define, or uses it differently, has a consistency bug.

## The platform and its surfaces

**Cog\*Portal.** The whole platform: a website, a Python CLI called `cogworks`, a Discord bot and activity, and a sandbox that runs student code. Written "the portal" when only the website is meant.

**The portal.** The website at the team's portal origin. Signing in, connecting a repository, starting runs, reading run pages, and the leaderboard all live here. A student's device stores which portal it is linked to, so "the portal" is a specific origin and not a generic one; see *portal origin*.

**Portal origin.** The scheme and host the CLI talks to, with no path, query, or credentials. It must be HTTPS unless the host is `localhost`, `127.0.0.1`, or `::1`, in which case HTTP is allowed. Set by `--portal`, then `COGPORTAL_URL`, then the active portal saved in the config file, in that order. A value with a path or a password in it is rejected before any request is made (`python/cogbench/src/cogbench/cli.py:96`).

**The terminal.** The `cogworks` command as a student runs it on their own machine. Seven listed commands: `check`, `test`, `run`, `report`, `link`, `sync`, `status`, plus a hidden, deprecated `doctor` alias for `check`.

**Setup-page CLI.** The `cogworks-benchmark` build that the setup page's "Install the CogWorks tool" line installs: a git commit of Cog\*Portal, pinned per deploy (`apps/portal/src/lib/benchmark-packages.ts:40`). It can be older than the portal serving the page. On the candidate `2ff32fa` it is `40d31a2`; on hosted beta `4984730` it is `b6bbffb`.

**Execution copy.** The temporary copy of the project, without `.git`, `.cogbench`, `__pycache__` or virtual environments, that `cogworks check` and `cogworks run` import and run the team's code from, in a child process. Files the code writes there are discarded afterwards (`python/cogbench/src/cogbench/execution.py:93`).

**Retained copy.** The copy of a trained weight file that `cogworks run` makes under `.cogbench/weights/<sha256>/<path>` before the benchmark loads it, with its length and SHA-256 recorded in the report. `cogworks sync` uploads this copy rather than the original, so a hosted run receives the bytes the local run scored (`python/cogbench/src/cogbench/storage.py:315`).

**The sandbox.** The isolated container on Modal where a hosted run happens. Nothing a student types reaches it directly; it reads their repository at a commit and reports back to the portal.

**The activity.** The Discord embedded application a student launches from a voice channel. It shows the team's state inside Discord rather than sending them to a browser.

**Console.** The page at `/run-surfaces/{id}` that follows one piece of work from a local run through hosted, official and published, over a WebSocket. It shows live events, a four-stage strip, and the Retry, verify, promote and publish controls; it is the only portal page that offers Retry. The Activity embeds the same view. The code calls the record behind it a *run surface*: created by `cogworks run --live` or by any hosted practice start, and kept as its stages advance. Reached from the run page's "Open current run", the run bubble and the Activity.

**Run bubble.** The one Discord message the platform keeps for a console in the team's bound channel. Posted when the console's record is first published, then edited in place (every two seconds while running, and again on each later stage). It names the runner, the commit, the steps, and at the end the result and up to two actions.

**Bound channel.** The Discord text channel a team creator or maintainer chose with `/cog`'s "Use this as our team channel". One channel per team, and a channel belongs to one team. Run bubbles and team nudges post only there; a console keeps the channel it was created with even if the team rebinds.

**Team nudge.** A one-time message the five-minute maintenance pass posts in a bound channel: no hosted run has scored 24 hours after the first attempt, or none has scored for 48 hours. Posted once per team per kind, never edited, never naming a person.

**Simulated.** The chip every run page carries when the portal's execution provider is the fixture rather than Modal: "Execution provider is in fixture mode. Results are scripted, not real evaluation." A development setting. Every local screenshot and video this set cites carries it.

## The unit of interaction

**Ask.** One thing a student asks the platform to do that has a beginning, a possibly long middle, and an end. Arriving on a route, submitting a form, pressing "Start run", typing a `cogworks` command and pressing return, and invoking a slash command are all asks. Every feature document narrates one ask through five phases: *asking*, *answered without work*, *the work begins*, *while it works*, *how it ends*.

**Asking.** The instant the student commits to the ask: the click, the return key, the route change. What is targeted, what is validated before anything runs, and what is captured so it can be restored are all decided here.

**Answered without work.** The short path. The ask ends before anything durable happens: a validation error, a usage message, an empty state, a refusal before the first side effect. Nothing is recorded, and every document says so explicitly, because "nothing is recorded" is a claim a tester can check.

**The work begins.** The first durable effect of an ask, such as admitting an execution, saving a report or posting a message. Leaving afterwards does not erase that effect. Admission reserves hosted capacity; only completion adds to used quota.

**While it works.** What updates, what streams, what the student can still do, and what is disabled.

**How it ends.** What is committed, what is shown, where the student lands, and the failure path.

## The team and its work

**Team.** A group of students who share one repository and one history of attempts. A student joins a team with a join code or creates one. Every run, report, and leaderboard entry belongs to the team, not to a person.

**The repository is the team.** The platform's rule that a team's identity is its GitHub repository: everyone with write access to it shares its attempts. Adding someone on the team page does not give them GitHub access, and the portal says so where it matters.

**Practice run.** A hosted evaluation visible to the team. A completed evaluation uses practice quota; a failed execution does not. See [credit and quota](cross-cutting/credit-and-quota.md).

**Promotion.** Starting an official evaluation of a finished practice run's commit. A separate, explicit act; a run is never promoted automatically. Its result reaches the leaderboard only when the team publishes it.

**Leaderboard entry.** A promoted run, visible to every team in the cohort. Carries the team name and the run's numbers, never a person's name and never a per-person number.

**Credit.** The team's allowance for completed hosted evaluations. Active executions reserve capacity, and failures use none. See [credit and quota](cross-cutting/credit-and-quota.md) for the limits.

**Retry.** Starting another execution of a failed run's recorded source and settings, in the same mode and view. The old execution remains history. Retry never substitutes the latest branch commit.

**Cohort.** The set of teams a leaderboard covers. A student belongs to exactly one.

**Onboarding path.** The four-step rule at the top of the sign-in, cohort and team pages, labeled "Sign in", "Cohort", "Team", "Set up". The steps are not links, and a finished step shows a tick.

**Check-off.** A one-line Python command the setup page prints under steps 1 to 3 while they are unticked. Pasted into the terminal, it posts a signed token that records that one step as the student's own report, shown as "Checked off by you". A later CLI report upgrades it; the wiring step cannot be checked off. Each token is signed for one account, team, step and benchmark and lasts seven days.

**Pending return.** A device-approval or Discord-link address (`/connections?user_code=…` or `/connections#discord=…`) saved in the tab when a signed-out student is sent to sign in. Sign-in and the landing page send the student back to it. No other address is remembered.

**Restore gate.** The portal's guard against showing one account's page to another. While the tab is hidden it conceals account-bound content; when the tab returns or is restored from the back/forward cache, it rereads the session before revealing anything. The same login and team get the same page back; a different one reloads the document (`apps/portal/src/components/RestoreGate.tsx`).

**Archive team.** A team row from a past course, with names replaced. Left out of the cohort's team list and refused on a direct join.

**Candidate.** A succeeded hosted practice run that has not been promoted. The Runs page offers only the newest one with a primary metric; any other is promoted from its own page. (The word *candidate* also names the `2ff32fa` build in this set's scope notes; context decides.)

**Official attempt.** The hosted evaluation of a promoted practice run's commit on the hidden split. Numbered by the team's completed official evaluations plus one when admitted, so two failures can share a number. Counts as one of three per benchmark version only if it completes.

**Published result.** The one official attempt a team selects per benchmark version for the leaderboard. Free, replaceable, never withdrawn. Hidden from the board if its scorer version is no longer the catalog's or it has no primary metric.

**Archive entry.** A leaderboard entry for a 2026 team scored after the course from its repository as left, under a replaced name. The server withholds its commit and repository.

**Scorer version.** The label of the rules that turned predictions into metrics. Recorded on each run; the leaderboard ranks only runs whose scorer version matches the catalog's for that benchmark version.

**Previous comparable run.** The team's most recent earlier run that succeeded in the same mode on the same benchmark version, found among the latest fifty. The run page's change column and the dashed curve behind a sweep compare against it; a run with none shows no change column.

**Stale-run sweep.** The five-minute maintenance pass that fails a hosted run still queued ten minutes after creation, or in any later phase sixty minutes after creation, with E-PROVIDER and "The execution provider stopped reporting progress." It marks the record only and stops nothing on Modal. It does not look at local live sessions (B-13).

**Recorded before it stopped.** Findings a failed execution still produced, such as a completion that arrived after the run was marked failed. Kept as that execution's evidence, shown only inside the failure card's details, never as a result; the run stays failed.

**History window.** The commits the team page's process panel reads: the most recent 40 on the default branch. When older commits exist, commit-based sentences say "in your most recent {n} commits" rather than "yet", because an absence in the window is not an absence in the project.

## Roles

There are two independent role systems, and confusing them is the most common mistake a reader of these documents can make. *Platform roles* say what someone may do across the cohort. *Team roles* say what they may do to one team, and are read from GitHub rather than stored as an opinion.

**Student.** The default platform role. May act on their own team and read their own team's runs.

**Staff.** May reach the admin page. A staff member is either an *owner* or someone an owner added to the staff roster.

**Owner.** A GitHub login listed in the platform's `PLATFORM_OWNER_LOGINS` setting. Deliberately never read from the database, so that a database compromise cannot mint one. With the setting unset, nobody is an owner. Owners may rotate the cohort join code, assign TAs, and edit the staff roster.

**TA.** Someone assigned to specific teams. A TA reaches the admin page but sees only the teams assigned to them, and is refused elsewhere with "This team is not assigned to you." Written *TA* throughout, never "teaching assistant", because that is the product's own word.

**Instructor console and TA workspace.** The two shapes of `/admin`. An owner sees the instructor console: join code, every live team, students without a team, and platform staff. Anyone else who passes the staff gate sees the TA workspace: only the teams they are assigned to as TA, with member controls. Rostered staff with no TA assignment see an empty workspace.

**Instructor.** The plain-English word these documents use when the distinction between owner, staff, and TA does not matter to the point being made. Where it does matter, the exact word is used instead.

**Team role.** One of `admin`, `maintain`, or `write`, mirroring the member's permission on the team's GitHub repository. The creator is stored as `admin`, and so is anyone who joins with admin permission on GitHub, so a team can have several *team admins*. Only a team admin sees the team page's controls. The stored value is not trusted on its own: every change to team settings re-reads the live GitHub permission and demotes the stored role when it no longer agrees. Nobody in the portal can remove a team admin. Anything below `write` cannot start or change a run.

**Signed out.** No session. Most routes redirect to sign-in; the ones that do not are named in [`foundations/identity-and-roles.md`](foundations/identity-and-roles.md).

**Device.** One machine linked to one portal origin with one token, created by `cogworks link`. Has a name, an expiry, and can be revoked. A device is not a session: signing out of the browser does not unlink a device.

## Running the code

**Discovery.** The platform's search for the functions a benchmark needs, done by importing a team's modules and calling their functions with inputs the benchmark supplies, until a set of them answers correctly. No adapter file and no configuration are required. The search is not a static analysis: it runs the code.

**Bound.** A stage of the benchmark's pipeline is bound when discovery found one of the team's functions that performs it and recorded how to call it. A binding records the function, the stage it filled, and the argument order used.

**Skipped.** A module discovery could not read. Its owner is `ours` when a package would not import or the file could not be loaded under any available name, and `theirs` for a syntax error, a module that raised on import, or one that took longer than 30 seconds. An `ours` skip blocks a verdict and produces *could not look*. `environment` survives in older records and blocks a verdict the same way, but nothing produces it now (`python/cogbench/src/cogbench/discover.py:280`).

**Wiring trace.** The ordered list of steps that ran, each naming the stage, the team's own function, what it received, and what it returned. It is the smallest failing reproduction the platform has, and it is what a scoreboard cannot express.

**Submission.** What gets scored. A declared `submission.py` or `benchmark_adapter.py` at the repository root always wins; discovery is what happens when there is none, which for every repository in the 2026 corpus is always.

**Contract check.** On a hosted run, the rail phase after Install in which the controller confirms that the installed benchmark plugin's versions match the run job and loads that run's cases. It does not run a case end to end; the nearest thing to a one-case run is discovery's acceptance test during Install. An official attempt starts here because it skips prepare. A version mismatch fails here as E-DATA (B-21).

**Prepared artifact.** The filesystem snapshot a successful practice prepare leaves behind: the unpacked repository, its installed packages and any uploaded weights, bound to a record of the sandbox image. An official attempt is scored from it without preparing again, and is refused before evaluation if the record does not match the run.

## What the platform claims

**Verified.** The portal observed it. Used only for facts the portal saw for itself; anything on a student's machine is theirs to confirm. One current use departs from this: the setup page draws a step reported by `cogworks check` from a linked device as "Verified" with a filled green mark, distinct from a step ticked by a *check-off*. Both originate on the student's machine. This set records that use as it is and carries the conflict as B-63.

**Self-reported.** A result the student's own machine produced and uploaded. Printed as `{benchmark} v{n} · LOCAL RUN · SELF-REPORTED` or `LOCAL TEST · SELF-REPORTED`, naming the command, or plain `LOCAL · SELF-REPORTED` from a CLI that did not record it. Shown on the Runs page under "Local reports" as "Self-reported, not promotable", never mixed with hosted numbers and never leaderboard-eligible.

**Refusal.** The platform declining to give a number, stated as a sentence with a reason. A refusal is not a failure and not a zero. It is what an instrument does when it knows it is out of calibration.

**Could not look.** The specific refusal for when the search could not read part of the repository for a reason that is the platform's, so it says nothing about whether the code is there. The sentence names a count and no cause: "This check could not read {one of your files | n of your files}, so it could not finish looking for the code this task needs." Distinct from "we looked and found nothing", which is a claim about the repository.

**Withheld.** A number that exists in principle but was not measured, so it is not reported and never drawn as zero. Week 3 withholds `overall` and the retrieval scores when the image side never bound, leading with `text_mrr`; it withholds `overall` and the search scores when the database or search function never bound, leading with `retrieval_mrr`. Floors stay, and a floor whose score was dropped keeps its own row on the run page. The first note begins "overall withheld: ". See [`sandbox/scoring-and-refusals.md`](sandbox/scoring-and-refusals.md).

**Readings.** The run page section under the finding: the primary metric on its first row and the supporting metrics below, grouped by role, with an uncolored change against the previous comparable run. Its heading names the split: "Public practice split." or "Hidden official split."

**Floor.** A number that is a property of the dataset rather than of the submission: what a trivial baseline scores. A floor is drawn as the scale its metric sits on, with no arrow, because "higher is better" on a floor reads as advice to raise a number the student does not control.

**Supplied by the benchmark.** Anything the platform provided rather than measured from the team's code: the name of each item, a GloVe table, a folder pointed at the benchmark's files, an id-to-name table over the enrolled songs. It is meant to be disclosed wherever it changes how a number should be read. In practice it appears only in `cogworks check --json`; see [`cross-cutting/what-the-benchmark-supplied.md`](cross-cutting/what-the-benchmark-supplied.md).

**No per-person numbers.** The platform's hardest rule: no number is ever attributed to an individual, in any form, including privately. A test fails the build on a field shaped like one (`python/cogbench/tests/test_process.py`). At `2ff32fa` and `17d26d9` three surfaces print a login beside a score; integrated `93dfa5e` source removes all three ([B-64](bug-triage.md#b-64-discord-and-the-console-put-a-students-login-beside-a-score)).

## Verdicts

The five things discovery can conclude, plus the refusal. Every one of them is a sentence the student reads, never a status code.

**Scored.** The code ran and produced a number. A low number is a result, not an error.

**Wired but wrong.** The pipeline ran end to end and returned the wrong answer on a case the benchmark made up and knows the answer to. The finding that matters most. The platform reports what ran and what came back, and never guesses why it is wrong.

**Not wired.** No chain of the team's functions performs the task. The headline names the hand-off that failed, not the task.

**Not read.** The code could not be imported, or the interpreter died trying. Names the module and the reason.

**Nothing here.** There is no Python in the repository yet.

## Events that end or interrupt an ask

**Stop it yourself.** Escape, a Cancel button, Ctrl+C, closing the activity. On the CLI, Ctrl+C exits 130 and prints `cogworks: interrupted`.

**Navigate away.** Leaving a route in the browser, or backgrounding the tab. Distinct from *reload*, which discards in-memory state the platform may not have persisted.

**A teammate acts.** Another member of the same team starting a run, pushing a commit, or changing membership while an ask is in flight. The team is the unit, so this is a normal condition and not an error.

**The portal fails.** A request errors or times out, the device token expires, or the browser session expires. The CLI retries a request marked retryable up to three attempts with backoff on 429, 500, 502, 503, and 504; other failures surface at once (`python/cogbench/src/cogbench/client.py:16`).

**The process goes away.** A reload, a closed tab, a closed terminal, or the sandbox container being killed. What survives is whatever was already durable when it happened.

**The target changes.** The repository moves to a new commit, the week rolls over to a new benchmark, or the benchmark version changes under a run in flight.

**Refused, or out of credit.** The platform declines the ask. Distinct from a failure: nothing went wrong, and the sentence says why.

## Units and identifiers

**Commit.** A forty-character git SHA. Shown to a student as its first seven characters, with `(dirty)` after it when the working tree had uncommitted changes at the time.

**Dirty.** The working tree had uncommitted changes when the report was made. A report from a dirty tree is still saved and still syncable; the word travels with it so nobody mistakes it for a reproducible result.

**Time.** Milliseconds since the epoch, UTC, everywhere on the wire. Rendered to a student in their own locale except in `cogworks status`, which prints an ISO 8601 UTC timestamp ending in `Z`.

**Report id.** `local_` followed by a hex string, for a report made on a student's machine. **Run id** identifies a hosted run. The prefixes are load-bearing: a local report is never shown as a hosted run.

**Benchmark id.** The entry-point name of a week's benchmark: `audio-identification` (Week 1), `vision-recognition` and `vision-clustering` (Week 2), `language-search` (Week 3). One week can ship more than one benchmark id, so a document never says "week" where it means "benchmark" (`python/cogbench/src/cogbench/environment.py:BENCHMARK_TRACKS`).

**Track.** Which week's image scores a benchmark id, and therefore which packages the graded run installs. `week1`, `week2`, `week3`. An unknown benchmark id resolves to no track rather than a guess.

**Hosted Python.** The interpreter the graded run executes student code on. Week 1 and Week 3 use a pinned CPython 3.8.20 venv baked into the image; everything else uses 3.11. Reporting the wrong one sends a student chasing a version difference that is not there (`python/cogbench/src/cogbench/cli.py:_HOSTED_PYTHON`).
