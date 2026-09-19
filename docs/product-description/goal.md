# Goal: complete the Cog\*Portal product description

You are working in `docs/product-description/` inside the Cog\*Portal repository. Read `README.md`, `glossary.md`, `foundations/the-ask.md`, and `terminal/status.md` first. The README defines the purpose, the document template, the method, the structure, and the coverage table. The other three are the exemplars: match their depth, tone, and structure exactly. Your job is to write every document in the README's structure until the coverage table has no `not started` rows, then run a consistency pass.

## Source of truth

Cog\*Portal is checked out at `/Users/samgu/BWSI/2026/CogPortal`, branch `fix/product-description-triage`, commit `f74e087`. Describe the experience of a student on a 2026 CogWorks capstone team, in the default configuration, with nothing customized, across four surfaces: the portal website, the `cogworks` CLI, Discord, and the sandbox as the student sees it through the run page.

**Do not modify anything outside `docs/product-description/`.** The rest of the repository is read-only reference material, and other people are editing it at the same time.

For each document, read in this order before writing:

1. Where the behavior is owned. For the portal, the route file under `apps/portal/src/routes/` and its handler under `apps/portal/worker/routes/`. For the terminal, the branch of `python/cogbench/src/cogbench/cli.py` and the module it calls. For Discord, `apps/discord-bot/src/commands.ts` and `apps/portal/worker/routes/activity.ts`. For the sandbox, the stage in `apps/runner-modal/src/cogworks_runner/modal_app.py`.
2. The shaping layer: `python/cogbench/src/cogbench/report.py` and `verdict.py` decide what a student reads from the CLI; `apps/portal/src/components/` decides what they read on a run page; `packages/discord-kit/src/` decides what a Discord message looks like.
3. The tests. They are close to executable specifications of the edge cases. `python/cogbench/tests/test_report.py`, `test_verdict.py`, `test_resolve.py`, `test_pipeline.py`; `apps/runner-modal/tests/test_prepare_rungs.py`, `test_failure_attribution.py`, `test_limit_attribution.py`; `apps/discord-bot/test/commands.test.ts`; `packages/discord-kit/test/kit.test.ts`.
4. Defaults, limits, and thresholds: `python/cogbench/src/cogbench/environment.py` (what each week installs), `apps/portal/worker/db/schema.ts` (what is durable), and the limit constants in `apps/portal/worker/execution/` and `modal_app.py`.

Do not describe code. Describe what the student sees and does. Technical detail goes only in `> Technical note:` block quotes, and only when the mechanism changes what the student would expect.

## Writing rules

- Follow the eight-section template in the README for every document. Foundations and cross-cutting documents may drop sections that do not apply, but must still cover cancel and interrupt behavior wherever an ask exists.
- Modifiers and cancel/interrupt go in tables, split into "Set before the ask" and "Changed while it works", as in `terminal/status.md`. The five modifier rows, the seven interrupt rows, and the eight cross-cutting concerns are fixed in the README. Do not add, drop, or reorder them in a single document. Fill every cell, "No effect." where that is the answer.
- Use the glossary's words. If you need a term the glossary lacks, add it to `glossary.md` in the right section with a full paragraph, then use it. Do not coin a synonym for a term that already exists.
- Sentence case for all headings. Direct, concrete language. No hedging, no marketing.
- **No em dashes anywhere.** Use commas, parentheses, semicolons, or two sentences. This is `docs/design/voice.md` and it is not negotiable. No emoji either.
- Apply the `unslop` skill to every sentence. Say what a thing does, not how it feels. Prefer the plain word. Active voice, named actor. Cut adverbs propping up weak verbs. If a sentence could appear unchanged in another project's documentation, it says nothing about this one; delete it.
- When quoting a string the student sees, quote it exactly and cite `file:line`. The strings are the product.
- State surprising behavior plainly and say why if the reason is in the code or a comment. This codebase's comments explain intent unusually well; where a comment gives a measured reason ("an empty repository scored 52% against the reference submission"), that reason belongs in the document.
- If something looks like a bug, say so in "Open questions" rather than smoothing it over, and make sure it reaches `bug-triage.md`.
- Cross-reference with relative links instead of repeating. `foundations/the-ask.md` owns the phase names and the interrupt definitions. `foundations/the-run.md` owns the run statuses and what a run costs. `foundations/what-the-portal-claims.md` owns verified, self-reported, refused, and withheld. Do not restate them; link.
- One Mermaid `stateDiagram-v2` per ask, limited to the states the student passes through.
- Every document ends with `## Open questions and verification`, a bullet list, then `Verified against Cog*Portal commit \`f74e087\`` (note: read against, not hand-verified; see below).

## This pass did not run the product

No browser verification, no live CLI runs against a deployed portal. Where the skill's method calls for trying something in the running product, write what the code says will happen and mark the sentence **unverified**. Do not guess beyond what the source supports. A behavior that cannot be determined from code and tests goes in "Open questions" and the document moves on.

## Files that were being edited during this pass

Four areas were in flight while these documents were drafted. Each affected document carries an "In flight" note at the top naming the exact files, so a verifier re-reads the source instead of trusting the prose:

- The team page process-signals panel and co-author credit: `apps/portal/src/routes/TeamPage.tsx`, `apps/portal/worker/services/process-signals.ts`.
- `cogworks sync` uploading the weights a local run used, and the hosted run fetching them: `python/cogbench/src/cogbench/cli.py`, `apps/portal/worker/routes/local-reports.ts`, the prepare stage of `apps/runner-modal/src/cogworks_runner/modal_app.py`.
- Removal of instructor adapters: `apps/runner-modal/src/cogworks_runner/modal_app.py`, `benchmarks/adapters/`.
- A Week 3 refusal sentence about withheld image scores: `benchmarks/week3/language_search_benchmark/plugins.py`, `roles.py`.

Draft these last, describe the intended behavior from the source as it reads at the time, and mark anything unconfirmed.

## Things already established (do not re-derive, do not contradict)

**The unit of interaction.** An *ask*, in five phases: asking, answered without work, the work begins, while it works, how it ends. "The work begins" is the moment abandoning stops being free, and every document names that moment exactly for its own feature.

**The stance.** This is an instrument that reports findings, not a judge that issues grades (`docs/design/the-instrument-not-the-judge.md`). Two rules fall out and hold everywhere: a run page leads with what the run shows, not what it scored; and there are no per-person numbers, in any form, ever, including private ones.

**Configuration precedence for the CLI.** `--portal`, then `COGPORTAL_URL`, then the active portal in `~/.cogbench/config.json` (or `COGBENCH_CONFIG`). No portal selected raises before any request: "No CogPortal is selected. Copy `cogworks link --portal ...` from the setup page." HTTPS is required except on `localhost`, `127.0.0.1`, `::1`.

**Exit codes.** `0` success (including a bare `cogworks` printing help), `2` for every handled failure and for a `check` whose required signals are not all true, `130` for Ctrl+C. There is no other exit code from `main`.

**Which subcommand is hidden.** `doctor` is hidden from the help listing; `test` is not. `test` carries help text and appears in the subparser metavar. Do not write that `test` is hidden.

**What `check` requires to exit 0.** `gitRepository`, `repositoryFullName`, `benchmarkInstalled`, `benchmarkLoadable`, `submissionLoadable`. `submissionInstalled` is deliberately not required, because a repository that resolves by file has no entry point.

**Where a local report goes.** `.cogbench/reports/local_<hex>.json` under the directory the command was run in, resolved once before any benchmark runs. `cogworks report` with no path reads the most recently modified one.

**What the CLI sends to the portal, and what it does not.** Setup check names, package versions, and the GitHub repository. Never source, paths, logs, predictions, scores, or environment variables. `cogworks link` prints this sentence before the handshake.

**Retries.** The CLI retries a request marked retryable up to three attempts, with 0.25 s doubling backoff, on 429, 500, 502, 503, 504, and on a connection failure. `update_setup_checks` deliberately does not retry: the student asked for one visible update and a failure should hand back control.

**Live sharing.** `cogworks run --live` opens a session, sends a heartbeat every 2 seconds, keeps at most 32 events in memory (dropping progress events first when it must), and on finish sends a terminal event plus a replay batch of that history with a 5 second deadline.

**Hosted interpreters.** Week 1 and Week 3 execute student code under a pinned CPython 3.8.20 venv at `/opt/cogworks-py38/bin/python`; everything else runs on 3.11. `cogworks check` prints the hosted interpreter only when it differs from the local one.

**Benchmark ids and tracks.** `audio-identification` is week1, `vision-recognition` and `vision-clustering` are week2, `language-search` is week3. One week can ship more than one benchmark id, so never write "week" where "benchmark" is meant. An unknown id resolves to no track rather than a guess.

**Quota, as the portal shows it.** Ten completed hosted practice evaluations and three completed official evaluations per team, benchmark and version. Valid low and partial results count. Failed executions use no quota. Active executions reserve capacity. Recovery policy was corrected against local `a0e8eac`; unchanged descriptions retain their earlier source references.

**Runs go one at a time per benchmark.** One active execution per team and benchmark, across versions. Retry preserves the recorded source, configuration, mode and view, with one successor per failed execution. Old failures and late findings remain history.

**Refusal, not failure.** When the platform manufactured an absence (a module skipped for the platform's own reason), it refuses to reach a verdict about the repository rather than reporting one. That refusal is `could_not_look`, and its sentence names the count of unread files and says the graded run installs those packages and will read them.

**Withheld numbers are never zeros.** Week 3 withholds `overall` and the image-side scores when the image side was never bound, keeps their floors, leads with `text_mrr`, and prints a diagnostic first that names the team's own save path.

**Floors carry no arrow.** A floor is a property of the dataset, so the renderer draws it as the scale of the metric it belongs to rather than as something to raise.

## Order of work

1. `foundations/` first, in this order: `the-ask.md`, `identity-and-roles.md`, `the-team-and-the-repository.md`, `the-run.md`, `what-the-portal-claims.md`. Everything else links to them.
2. The run, next: `portal/start-a-practice-run.md`, `portal/watching-a-run.md`, `portal/the-run-page.md`, and all four `sandbox/` documents. Read every stage of `modal_app.py` before starting any of them, because the stages hand off to each other. `sandbox/prepare.md` owns everything up to the first student import; `sandbox/discovery.md` owns the search; `sandbox/scoring-and-refusals.md` owns metrics and refusals; `sandbox/timeouts-and-limits.md` owns every limit and its attribution. `portal/the-run-page.md` owns what the finished run looks like; `portal/watching-a-run.md` owns the live surface.
3. The remaining `portal/`, `terminal/`, `discord/`, and `cross-cutting/` documents. These are independent and can be drafted in parallel.
4. Consistency pass over the whole set.
5. `bug-triage.md` and `verification/` last, built from what the documents raised.

## Working rules

- This work is not committed. Write files under `docs/product-description/` and leave the git index alone.
- Do not add files outside the README's structure without updating the structure and coverage table to match.
- Depth bar: `terminal/status.md` is about 180 lines for a small command. `portal/the-run-page.md` and the sandbox documents run 250 to 300. Completeness matters more than length. Every phase, every modifier cell, every interrupt cell, even when the answer is "no effect".
- If the README's structure turns out wrong for something you discover, change it, and update the structure and the coverage table together.
