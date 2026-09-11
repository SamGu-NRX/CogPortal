# Glossary

The vocabulary used across these documents. When a document uses one of these words, it means exactly this. A document that uses a term of art this file does not define, or uses it differently, has a consistency bug.

## The platform and its surfaces

**Cog\*Portal.** The whole platform: a website, a Python CLI called `cogworks`, a Discord bot and activity, and a sandbox that runs student code. Written "the portal" when only the website is meant.

**The portal.** The website at the team's portal origin. Signing in, connecting a repository, starting runs, reading run pages, and the leaderboard all live here. A student's device stores which portal it is linked to, so "the portal" is a specific origin and not a generic one; see *portal origin*.

**Portal origin.** The scheme and host the CLI talks to, with no path, query, or credentials. It must be HTTPS unless the host is `localhost`, `127.0.0.1`, or `::1`, in which case HTTP is allowed. Set by `--portal`, then `COGPORTAL_URL`, then the active portal saved in the config file, in that order. A value with a path or a password in it is rejected before any request is made (`python/cogbench/src/cogbench/cli.py:96`).

**The terminal.** The `cogworks` command as a student runs it on their own machine. Six commands: `check`, `run`, `report`, `link`, `sync`, `status`, plus a hidden `test` and a deprecated `doctor` alias for `check`.

**The sandbox.** The isolated container on Modal where a hosted run happens. Nothing a student types reaches it directly; it reads their repository at a commit and reports back to the portal.

**The activity.** The Discord embedded application a student launches from a voice channel. It shows the team's state inside Discord rather than sending them to a browser.

## The unit of interaction

**Ask.** One thing a student asks the platform to do that has a beginning, a possibly long middle, and an end. Arriving on a route, submitting a form, pressing "Start run", typing a `cogworks` command and pressing return, and invoking a slash command are all asks. Every feature document narrates one ask through five phases: *asking*, *answered without work*, *the work begins*, *while it works*, *how it ends*.

**Asking.** The instant the student commits to the ask: the click, the return key, the route change. What is targeted, what is validated before anything runs, and what is captured so it can be restored are all decided here.

**Answered without work.** The short path. The ask ends before anything durable happens: a validation error, a usage message, an empty state, a refusal before the first side effect. Nothing is recorded, and every document says so explicitly, because "nothing is recorded" is a claim a tester can check.

**The work begins.** The moment abandoning the ask stops being free. It is a different moment on each surface and each document names it exactly: the run row is written and credit is spent; the first byte is written to `.cogbench/reports/`; the sandbox's first container starts; the Discord bubble is posted. Before this moment an interrupt leaves nothing behind. After it, something survives.

**While it works.** What updates, what streams, what the student can still do, and what is disabled.

**How it ends.** What is committed, what is shown, where the student lands, and the failure path.

## The team and its work

**Team.** A group of students who share one repository and one history of attempts. A student joins a team with a join code or creates one. Every run, report, and leaderboard entry belongs to the team, not to a person.

**The repository is the team.** The platform's rule that a team's identity is its GitHub repository: everyone with write access to it shares its attempts. Adding someone on the team page does not give them GitHub access, and the portal says so where it matters.

**Practice run.** A hosted run that scores the team's repository and is visible only to the team. Costs credit. The default: pressing "Start run" makes a practice run.

**Promotion.** Turning a finished practice run into a leaderboard entry. A separate, explicit act; a run is never promoted automatically.

**Leaderboard entry.** A promoted run, visible to every team in the cohort. Carries the team name and the run's numbers, never a person's name and never a per-person number.

**Credit.** The budget a team spends to start a hosted run. Spent when the work begins and refunded when the platform decides a failure was its own rather than the team's. See [`cross-cutting/credit-and-quota.md`](cross-cutting/credit-and-quota.md) for the numbers and the refund rules.

**Cohort.** The set of teams a leaderboard covers. A student belongs to exactly one.

## Roles

There are two independent role systems, and confusing them is the most common mistake a reader of these documents can make. *Platform roles* say what someone may do across the cohort. *Team roles* say what they may do to one team, and are read from GitHub rather than stored as an opinion.

**Student.** The default platform role. May act on their own team and read their own team's runs.

**Staff.** May reach the admin page. A staff member is either an *owner* or someone an owner added to the staff roster.

**Owner.** A GitHub login listed in the platform's `PLATFORM_OWNER_LOGINS` setting. Deliberately never read from the database, so that a database compromise cannot mint one. With the setting unset, nobody is an owner. Owners may rotate the cohort join code, assign TAs, and edit the staff roster.

**TA.** Someone assigned to specific teams. A TA reaches the admin page but sees only the teams assigned to them, and is refused elsewhere with "This team is not assigned to you." Written *TA* throughout, never "teaching assistant", because that is the product's own word.

**Instructor.** The plain-English word these documents use when the distinction between owner, staff, and TA does not matter to the point being made. Where it does matter, the exact word is used instead.

**Team role.** One of `admin`, `maintain`, or `write`, mirroring the member's permission on the team's GitHub repository. `admin` is the creator. The stored value is not trusted on its own: every change to team settings re-reads the live GitHub permission and demotes the stored role when it no longer agrees. Anything below `write` cannot start or change a run.

**Signed out.** No session. Most routes redirect to sign-in; the ones that do not are named in [`foundations/identity-and-roles.md`](foundations/identity-and-roles.md).

**Device.** One machine linked to one portal origin with one token, created by `cogworks link`. Has a name, an expiry, and can be revoked. A device is not a session: signing out of the browser does not unlink a device.

## Running the code

**Discovery.** The platform's search for the functions a benchmark needs, done by importing a team's modules and calling their functions with inputs the benchmark supplies, until a set of them answers correctly. No adapter file and no configuration are required. The search is not a static analysis: it runs the code.

**Bound.** A stage of the benchmark's pipeline is bound when discovery found one of the team's functions that performs it and recorded how to call it. A binding records the function, the stage it filled, and the argument order used.

**Skipped.** A module discovery could not read. Every skip carries an owner: `ours` (a package the graded run installs but this machine lacks, or a loader defect), `environment` (a package genuinely absent from the graded run too), or `theirs` (a syntax error, or a module that raises on import). The owner decides what may be said about the repository afterwards; see *could not look*.

**Wiring trace.** The ordered list of steps that ran, each naming the stage, the team's own function, what it received, and what it returned. It is the smallest failing reproduction the platform has, and it is what a scoreboard cannot express.

**Submission.** What gets scored. A declared `submission.py` or `benchmark_adapter.py` at the repository root always wins; discovery is what happens when there is none, which for every repository in the 2026 corpus is always.

**Contract check.** The fast pass that runs one case end to end before the full evaluation, so that a broken pipeline fails in seconds rather than after the whole dataset.

## What the platform claims

**Verified.** The portal observed it. Used only for facts the portal saw for itself. Anything on a student's machine is theirs to confirm and is never called verified.

**Self-reported.** A result the student's own machine produced and uploaded. Shown with the words `LOCAL · SELF-REPORTED` and never mixed with hosted numbers.

**Refusal.** The platform declining to give a number, stated as a sentence with a reason. A refusal is not a failure and not a zero. It is what an instrument does when it knows it is out of calibration.

**Could not look.** The specific refusal for when the platform manufactured the absence: a module was skipped for a reason that is the platform's, so no verdict about the repository is supported. Distinct from "we looked and found nothing", which is a claim about the repository.

**Withheld.** A number that exists in principle but was not measured, so it is not reported. Week 3 withholds `overall` and the three image-side scores when the image side was never bound, and leads with `text_mrr` instead. A withheld number is never rendered as zero. The floors of the withheld scores stay in the payload, but the run page draws a floor inline on the row of the metric it belongs to, and that row no longer exists, so those floors are on the wire and off the screen. See [`sandbox/scoring-and-refusals.md`](sandbox/scoring-and-refusals.md).

**Floor.** A number that is a property of the dataset rather than of the submission: what a trivial baseline scores. A floor is drawn as the scale its metric sits on, with no arrow, because "higher is better" on a floor reads as advice to raise a number the student does not control.

**Supplied by the benchmark.** Anything the platform provided rather than measured from the team's code: the name of each item, a GloVe table, a folder pointed at the benchmark's files, an id-to-name table over the enrolled songs. It is meant to be disclosed wherever it changes how a number should be read. In practice it appears only in `cogworks check --json`; see [`cross-cutting/what-the-benchmark-supplied.md`](cross-cutting/what-the-benchmark-supplied.md).

**No per-person numbers.** The platform's hardest rule: no number is ever attributed to an individual, in any form, including privately. A test fails the build on a field shaped like one (`python/cogbench/tests/test_process.py`).

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
