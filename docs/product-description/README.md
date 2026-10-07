# Cog\*Portal product description

A written description of the user experience of Cog\*Portal: what a student sees, what they can do, and exactly what happens when they do it.

## Purpose

Cog\*Portal is, from the outside, a large state chart. A student moves through it by signing in, connecting a repository, typing commands in a terminal, pressing buttons in a browser, and running slash commands in Discord. Most of the behavior is defined implicitly, spread across React routes, a Cloudflare Worker, a Python CLI, a Modal sandbox, and the benchmark plugins. There is no single place that says, in plain language, "when the student does X, this is what happens, and this is what happens if they do Y halfway through."

This project is that place. It describes the whole experience of a student on a 2026 CogWorks capstone team, in the default configuration, with nothing customized.

The documents are for people who need to understand or change the platform: designers, engineers, writers, testers, and anyone deciding whether a behavior is intentional. They are written from the outside in. They describe the experience, not the implementation.

### What this is not

- Not API documentation. The wire contracts live in `packages/contracts` and in the route handlers under `apps/portal/worker/routes/`.
- Not organized by package. `cogbench`, `discord-kit`, `cogworks_runner`, and the worker are not described separately. A behavior is described once, wherever the student meets it.
- Not a technical design document. The reasoning behind the platform's stance lives in `docs/design/the-instrument-not-the-judge.md` and `docs/design/voice.md`. Where a mechanism changes what a student would expect, it appears here in a block quote labeled `Technical note:` and nowhere else.

## Conventions

- Describe the experience, not the code. "The check prints what was found, then one line saying either you are ready or here is the next thing" rather than "`render_check` returns a list of lines".
- Technical detail goes in block quotes prefixed `Technical note:`. Use it only when the mechanism changes what the student would expect.
- Sentence case for headings. No em dashes anywhere, in keeping with `docs/design/voice.md`. No emoji.
- The [glossary](glossary.md) is the source of truth for the vocabulary: *ask*, *bound*, *skipped*, *refusal*, *wiring trace*, *verified*, *self-reported*, *practice run*, *promotion*, *credit*, *withheld*.
- Every document ends with the Cog\*Portal commit it was read against and a list of open questions.
- Surprising behavior is stated plainly, with the reason when the code or a comment gives one. Where something looks like a defect, the document says so in "Open questions" and the item is carried into [`bug-triage.md`](bug-triage.md).

## The work to be done

Each document describes one feature. Features are large (the run page) or small (`cogworks status`), but each is described in full, including its edge cases and its interactions with the rest of the platform.

### Document template

Every feature document follows the same skeleton so that documents are comparable and nothing is skipped.

1. **Summary.** One paragraph describing the feature abstractly, then where it lives and how it is reached.
2. **The simple case.** The common path in prose.
3. **The ask, event by event.** The five phases of an *ask*, which is this platform's unit of interaction: **asking**, **answered without work**, **the work begins**, **while it works**, **how it ends**. What starts it and what is captured, what happens when it ends at once, what is decided the moment work begins and can no longer be taken back for free, what updates live, and what is committed at the end. Include a Mermaid `stateDiagram-v2` of the states the student passes through.
4. **Modifiers.** A table with the same five rows in every document, showing what each one does when set before the ask and when changed while the work runs:
   - Who you are (signed out, student, team member, instructor)
   - Where your team and repository stand (no team, a team with no repository, a repository connected, setup incomplete)
   - Which week's benchmark (Week 1 audio identification, Week 2 vision, Week 3 language search)
   - Practice or leaderboard
   - Flags, options, and where you are typing (CLI flags and environment, a terminal or a pipe, a Discord channel or the activity, a portal page)
5. **Cancel and interrupt.** The same seven rows, in this order, in every document:
   - You stop it yourself (Escape, Cancel, Ctrl+C, closing the dialog or the activity)
   - You do something else mid-way (navigate away, start a second run, run a second command)
   - A teammate acts at the same time (a second run, a push, a membership change)
   - The network or the portal fails (a request fails or times out, the device token expires, the session expires)
   - The page or the process goes away (reload, tab closed, terminal closed, the sandbox killed)
   - The thing being measured changes (the repository moves, the week rolls over, the benchmark version changes)
   - The platform refuses or credit runs out
6. **Interactions with other systems.** The same eight concerns, in this order, in every document: **Who may do this.** **The team owns it.** **Credit.** **What the portal claims.** **What the benchmark supplied.** **Live updates and reconnection.** **Discord.** **Configuration.**
7. **Edge cases.** Anything a student could notice that is not covered above.
8. **Open questions and verification.** The Cog\*Portal commit the document was read against, and any behavior that could not be confirmed.

Item 5 matters most. Asking the same interrupt questions of every feature is how gaps and inconsistencies are found.

### Method

For each document:

1. Read the route handler, command, or sandbox stage that owns the behavior.
2. Read the matching tests. `python/cogbench/tests/`, `apps/runner-modal/tests/`, `apps/discord-bot/test/`, and `packages/discord-kit/test/` read as executable specifications of the edge cases.
3. Draft the document.
4. Try anything ambiguous against the running platform. Tests settle what happens; the running platform settles how it feels, what is visible while work is in progress, and what the timing is like.
5. Record the commit read against.

This pass did step 3 and not step 4. See [Scope decisions](#scope-decisions).

### Verification

Drafting reads the code; verification watches the platform. The `verification/` directory holds one checklist per flow, each item a single observable claim with setup, steps, expected result, a priority, and what it needs. A tester runs them, records `pass`, `fail`, or `blocked` in the Result column, and files every failure in [`bug-triage.md`](bug-triage.md) with the item's ID. A document moves from `drafted` to `verified` in the coverage table only when every P1 and P2 item for it has passed or been filed.

`bug-triage.md` is the other half: every behavior the documents flagged as a likely defect, deduplicated, with reproduction steps, the reason in the code, a severity, and the decision the product team needs.

### Order of work

1. **Pilot: [`terminal/status.md`](terminal/status.md).** Small, self-contained, and it touches every noun the platform has. Used to settle the template, tone, and depth.
2. **Foundations.** The five documents everything else links to.
3. **The hardest area: the run.** Starting a run, watching it, the run page, and the four sandbox documents. These hand off to each other and had to agree on where one ends and the next begins.
4. **Everything else,** then a consistency pass.

Progress is tracked in the [coverage table](#coverage) below.

### Scope decisions

- **Four flows, one document set.** The skill this repo was built from would normally give each surface its own repo, because the unit of interaction differs per surface. That was overridden deliberately: a student crosses all four surfaces in one afternoon, and the interesting inconsistencies are exactly the ones that live between them. The cost is that the five phases of an *ask* are named generically enough to cover a page arrival, a shell invocation, a slash command, and a sandbox stage. Where a surface's own words are clearer, the document says both.
- **No browser verification in this pass.** The documents were drafted from code and tests only. Anything the skill's process would settle by running the product is written from what the code says will happen and marked **unverified**. A separate pass drives the browser after today's changes land.
- **2026-09-10, the first-use restoration.** `portal/setup.md` was corrected where it had drifted: the tool is installed from a pinned commit with `--force-reinstall` rather than from a branch with `--upgrade`, the page carries titles and reasons again rather than five bare commands, and completion shows a panel. `SETUP-02`, `-05`, `-06` and `-07` were rewritten because the behaviour they described no longer exists, and `SETUP-08` to `-14`, `SIGNIN-06` to `-09` and `START-07` to `-08` were added for the restored guidance. Every one of them is `not run`. The implementer drove the local pages while building them, which is not a verification pass and did not move any Result: reading code and clicking your own work are the two things the Result column is not allowed to record.
- **Source files were changing while this was written.** Four areas were being edited by other agents during the drafting pass. Each affected document carries an "In flight" note naming the files, so the verifier re-reads the source rather than trusting the prose. They are: the team page process-signals panel and co-author credit; `cogworks sync` uploading the weights a local run used and the hosted run fetching them; the removal of instructor adapters; and a Week 3 refusal sentence about withheld image scores.
- **Instructor and operator surfaces are described only where a student meets them.** The runbooks under `docs/runbooks/` and the Modal deploy path are out of scope. `portal/admin.md` covers the admin page because an instructor is a real user of it, but the operator tooling behind it is not described.
- **Benchmark internals are out of scope.** How Week 3 computes `text_mrr` is the benchmark's business. What the student sees (which numbers appear, which are withheld and why, which are floors rather than scores) is in scope and is described in [`cross-cutting/what-the-benchmark-supplied.md`](cross-cutting/what-the-benchmark-supplied.md).
- **Interaction shape.** The unit of interaction is an *ask* and its phases are asking / answered without work / the work begins / while it works / how it ends. The interrupt list and the order of cross-cutting concerns are fixed as written in the document template above.

## Structure

```
README.md                        this file
goal.md                          the standing instructions for whoever drafts
AGENTS.md, CLAUDE.md             entry points for agents: read README.md, then goal.md
glossary.md                      shared vocabulary
bug-triage.md                    suspected defects collected from every document

verification/
  README.md                      how to run a hand-verification pass and record results
  portal.md                      checklists for portal/*
  terminal.md                    checklists for terminal/*
  discord.md                     checklists for discord/*
  sandbox.md                     checklists for sandbox/* and cross-cutting/*

foundations/
  the-ask.md                     the unit of interaction: the five phases, what commits, what
                                   is free to abandon, and what each interrupt word means
  identity-and-roles.md          signing in, linking a device, the roles and what each may do
  the-team-and-the-repository.md what a team is, why the repository is the team, membership
  the-run.md                     what a run is, its statuses, practice against leaderboard, credit
  what-the-portal-claims.md      verified, self-reported, refused, withheld: the trust vocabulary

portal/
  sign-in.md                     the sign-in page and the GitHub handshake
  connect-a-repository.md        connecting or forking the team repository
  join-or-make-a-team.md         the join code, creating a team, and joining an existing one
  setup.md                       the setup guide and how its steps are marked done
  start-a-practice-run.md        choosing a benchmark and pressing start
  watching-a-run.md              the live run surface while the sandbox works
  the-run-page.md                metrics, the refusal card, the wiring trace, diagnostics
  promote-to-the-leaderboard.md  turning a practice run into a leaderboard entry
  the-leaderboard.md             the leaderboard page
  the-team-page.md               the team page, its process-signals panel, and co-author credit
  admin.md                       the instructor's view

terminal/
  status.md                      `cogworks status` (the pilot)
  check.md                       `cogworks check`, the longest and most-read output
  run.md                         `cogworks run`, including `--live`
  report.md                      `cogworks report`
  link.md                        `cogworks link`, the device handshake
  sync.md                        `cogworks sync`

discord/
  commands.md                    every slash command and what it replies
  the-activity.md                the Discord activity and how it establishes identity
  channel-messages.md            what the platform posts without being asked

sandbox/
  prepare.md                     getting the repository and an environment ready to score
  discovery.md                   finding the team's functions by running them
  scoring-and-refusals.md        what produces a metric and when the platform refuses one
  timeouts-and-limits.md         every limit, and who a timeout is attributed to

cross-cutting/
  credit-and-quota.md            what a run costs, what is refunded, what happens at zero
  refusals-and-disclosure.md     the refusal vocabulary across all four surfaces
  live-updates.md                the run surface, heartbeats, reconnection, and replay
  what-the-benchmark-supplied.md what the platform discloses it provided rather than measured
```

## Coverage

Status is one of `not started`, `drafted`, or `verified`. No document is `verified`: this pass did not run the product. Documents whose source was being edited during drafting are marked `drafted (in flight)`.

| Document | Status |
| --- | --- |
| glossary.md | drafted |
| bug-triage.md | drafted |
| verification/README.md | drafted |
| verification/portal.md | drafted |
| verification/terminal.md | drafted |
| verification/discord.md | drafted |
| verification/sandbox.md | drafted |
| foundations/the-ask.md | drafted |
| foundations/identity-and-roles.md | drafted |
| foundations/the-team-and-the-repository.md | drafted |
| foundations/the-run.md | drafted |
| foundations/what-the-portal-claims.md | drafted |
| portal/sign-in.md | drafted |
| portal/connect-a-repository.md | drafted |
| portal/join-or-make-a-team.md | drafted |
| portal/setup.md | drafted |
| portal/start-a-practice-run.md | drafted |
| portal/watching-a-run.md | drafted |
| portal/the-run-page.md | drafted |
| portal/promote-to-the-leaderboard.md | drafted |
| portal/the-leaderboard.md | drafted |
| portal/the-team-page.md | drafted (in flight) |
| portal/admin.md | drafted |
| terminal/status.md | drafted |
| terminal/check.md | drafted |
| terminal/run.md | drafted |
| terminal/report.md | drafted |
| terminal/link.md | drafted |
| terminal/sync.md | drafted (in flight) |
| discord/commands.md | drafted |
| discord/the-activity.md | drafted |
| discord/channel-messages.md | drafted |
| sandbox/prepare.md | drafted (in flight) |
| sandbox/discovery.md | drafted |
| sandbox/scoring-and-refusals.md | drafted (in flight) |
| sandbox/timeouts-and-limits.md | drafted |
| cross-cutting/credit-and-quota.md | drafted |
| cross-cutting/refusals-and-disclosure.md | drafted |
| cross-cutting/live-updates.md | drafted |
| cross-cutting/what-the-benchmark-supplied.md | drafted |

## Reference

The source of truth is Cog\*Portal at `/Users/samgu/BWSI/2026/CogPortal`, branch `fix/product-description-triage`, commit `f74e087`. The relevant locations:

- `apps/portal/src/routes/`: the browser surface, one file per route.
- `apps/portal/src/components/`: the run page's pieces (metrics, the refusal card, the wiring trace, diagnostics).
- `apps/portal/worker/`: the backend. `routes/` for what each request does, `services/` for the shaping, `execution/` and `orchestration/` for the run lifecycle, `db/schema.ts` for what is durable.
- `python/cogbench/src/cogbench/`: the CLI. `cli.py` is the whole command surface; `report.py`, `verdict.py`, and `progress.py` decide what a student reads.
- `python/cogbench/tests/`: behavioral tests. `test_report.py`, `test_verdict.py`, `test_resolve.py`, and `test_pipeline.py` are close to executable specifications.
- `apps/runner-modal/src/cogworks_runner/modal_app.py`: the sandbox, from prepare to score.
- `apps/runner-modal/tests/`: `test_prepare_rungs.py`, `test_failure_attribution.py`, and `test_limit_attribution.py` are the specifications for what a student is told when a run fails.
- `apps/discord-bot/src/` and `packages/discord-kit/src/`: the Discord surface.
- `benchmarks/week1/`, `week2/`, `week3/`: the plugins that decide which numbers exist and which are withheld.
- `python/cogbench/src/cogbench/environment.py`: the package list each week's graded run installs, as data.
- `docs/design/voice.md`: the voice every student-facing string answers to.
- `docs/design/the-instrument-not-the-judge.md`: why the platform reports findings rather than grades.
