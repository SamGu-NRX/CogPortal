# Bug triage

Every defect and inconsistency the feature documents raised, in their bodies and in their "Open questions and verification" sections, deduplicated by root cause and written up so the product team can decide each one without re-reading the documents.

Each entry was read from the Cog\*Portal source and its tests at commit `f74e087`, plus the uncommitted work in flight on 2026-09-03. **None has been confirmed against the running platform.** This pass did not open a browser, did not deploy the bot, and did not start a hosted run. No entry carries a Status line yet; the checklists in [`verification/`](verification/README.md) are how they get one.

## Summary

Around a hundred and twenty items were raised across the document set. After merging by root cause they come to 46 entries: 18 high, 18 medium, 10 low. The ordering inside each severity band is by how early a first-time student would meet the problem, walking the real path: sign in, join a cohort, connect a fork, work the setup guide, link a device, run `cogworks check`, run locally, sync, start a hosted run, read the run page, promote, and use Discord alongside all of it.

Three clusters account for most of the high entries.

**The platform breaks its own honesty rules in five places.** It is built on the rule that it only claims what it observed, and enforces that rule with tests. Yet Week 1 runs student code under a randomized hash seed while a test written to prevent exactly that quietly excludes the image it was meant to guard (B-01); the "supplied" disclosure that the code says a run page shows reaches nothing but `--json` (B-04); a repository swap rewrites what earlier run pages claim about the past (B-06); Discord's confirmation dialog says a hosted practice run spends nothing while the quota counts it (B-09b); and the admin console prints a usage number that can exceed its own maximum, because the numerator and the denominator count different things (B-09c). None of these is cosmetic. Each makes the product assert something it cannot support.

**A student can get stuck, or silently lose a result, in four ways, all early.** Signing in leaves them on the page they started from (B-00). Linking a device before joining a team burns ten minutes of silence and destroys the code (B-02). There is no control anywhere that lets a student leave a team, so a mis-join needs the team creator or an instructor (B-07). Uploaded weights are keyed to a commit, so syncing and then pushing silently un-supplies them with no message anywhere (B-08). And the Week 3 sentence that explains all of this arrives truncated mid-word, because it is longer than the field that carries it (B-09a).

**The order of operations wastes the student's time in two commands.** `cogworks run --live` validates its two preconditions after the discovery search, which the 2026 corpus measures at up to ninety seconds (B-05), and `cogworks check --update-setup` silently drops the flag when the check does not pass (B-16).

A fourth pattern runs through the low band and is cheap to fix: five hardcoded copies of the official-attempt limit, and four em dashes in user-facing strings that `docs/design/voice.md` bans outright, one of which the style guide uses as its own worked example of what not to write.

Four entries describe work that landed during the drafting pass and may already have moved again: B-08, B-09, B-09a, and B-30. Read the source before acting on them.

| ID | Title | Severity | Area | Decision needed |
| --- | --- | --- | --- | --- |
| B-00 | A successful GitHub sign-in leaves the student on the marketing page | high | portal | fix |
| B-00a | A partial GitHub outage silently shortens the repository list | high | portal | fix |
| B-01 | Week 1 scores student code under a randomized hash seed, and the guard test cannot see it | high | sandbox | fix |
| B-02 | Linking a device before joining a team destroys the code after ten silent minutes | high | terminal, portal | fix |
| B-04 | The "supplied" disclosure never reaches the hosted run page | high | sandbox, portal | fix |
| B-05 | `cogworks run --live` checks its preconditions after the ninety-second search | high | terminal | fix |
| B-06 | Changing the repository rewrites what every earlier run page claims | high | portal | fix |
| B-07 | Nothing lets a student leave a team, and only the creator can let them out | high | portal | product call |
| B-08 | Uploaded weights are keyed to a commit, and nothing tells the student that | high | terminal, sandbox | product call |
| B-09 | The weight upload has a fifteen-second timeout and a two-hundred-megabyte ceiling | high | terminal | fix |
| B-09a | The Week 3 withheld sentence is cut off mid-word before the student reads it | high | sandbox | fix |
| B-09b | Discord tells a student a hosted practice run is free | high | discord | fix |
| B-09c | The admin console counts quota differently from the quota | high | portal | fix |
| B-10 | `cogworks check` can exit 0 on a repository `cogworks run` refuses | high | terminal | fix |
| B-11 | Week 2 never attributes a timeout, so a killed run spends an attempt under the wrong category | high | sandbox | fix |
| B-12 | `/cog view:connect` for an already-linked student is a dead end | high | discord | fix |
| B-13 | An interrupted `--live` run leaves the session running and the team's bubble frozen forever | high | terminal, discord | fix |
| B-14 | One member's expired GitHub token blanks the team's process panel for thirty minutes | high | portal | fix |
| B-03 | Two gates disagree about which team members Discord serves | medium | discord | fix |
| B-15 | Re-linking a device accumulates live tokens that nothing revokes | medium | terminal, portal | fix |
| B-16 | `check --update-setup` is silently ignored when the check does not pass | medium | terminal | fix |
| B-17 | The two longest paragraphs in `cogworks check` are the two that are not wrapped | medium | terminal | fix |
| B-18 | The most ordinary failure verdict has no next step | medium | terminal | fix |
| B-19 | The Discord bot replaces every actionable portal error with one generic sentence | medium | discord | fix |
| B-20 | The live run surface is unreachable from the portal and has no way out | medium | portal | product call |
| B-21 | A plugin version mismatch is reported to the student as missing benchmark data | medium | sandbox | fix |
| B-22 | The evaluation progress counter never moves | medium | sandbox, portal | fix |
| B-23 | Promote is clickable while the quota is still loading | medium | portal | fix |
| B-24 | The refund cap is bypassed when Modal dispatch fails | medium | portal | fix |
| B-25 | The Week 3 timeout message is Week 1's copy, about songs | medium | sandbox | fix |
| B-26 | Floors print as ordinary scores in the terminal | medium | terminal | fix |
| B-27 | A batch of live events applies partially and reports failure | medium | portal | fix |
| B-28 | The connections page polls forever while no device is linked | medium | portal | fix |
| B-29 | A member added from the team page gets write access the portal never checked | medium | portal | fix |
| B-30 | Co-author credit reaches half the process panel | medium | portal | fix |
| B-31 | Inactive benchmarks are publicly listed and their leaderboard tabs are clickable | medium | portal | fix |
| B-32 | The device has two different names | low | terminal, portal | fix |
| B-33 | `--json` output is interleaved with a plain-text line | low | terminal | fix |
| B-34 | A malformed response gives a traceback instead of a sentence | low | terminal | fix |
| B-35 | The official-attempt limit is hardcoded in five places | low | portal, discord | fix |
| B-36 | Four user-facing strings use em dashes, which the voice guide bans | low | portal, discord | fix |
| B-37 | `cancelled` is a status nothing can ever produce | low | portal | product call |
| B-38 | Four dead code paths and one tautological test | low | discord, portal | fix |
| B-39 | Revoking a device and unlinking Discord have no confirmation | low | portal | fix |
| B-40 | The rail marks every stage done as soon as a result is published | low | discord | fix |
| B-41 | Small copy and consistency slips | low | portal, terminal | fix |

## High

### B-00: A successful GitHub sign-in leaves the student on the marketing page

- **Where the user meets it:** Every student, once, on their very first action. They sign in with GitHub and land back on the landing page instead of on the next step.
- **What happens / what was expected:** The GitHub callback returns the student to `/`, and the landing page only forwards them onward when a pending connection return happens to be stored. So a first-time student, who has none, reads the marketing page again and has to find and press "Open Dashboard" to continue. The sign-in route itself does the opposite for the same state: if a signed-in student opens `/signin`, it computes the next unfinished stage and sends them there. Expected: the two agree, and signing in advances the student.
- **Reproduce:** With an account that has never signed in to this portal, complete GitHub sign-in from `/signin` and note where the browser lands.
- **Why (from the code):** `callbackURL: "/"` at `apps/portal/worker/routes/github.ts:72`; the landing page forwards only on a stored return at `apps/portal/src/routes/Landing.tsx:22`; the sign-in route's own redirect is at `apps/portal/src/routes/SignInPage.tsx:22`.
- **Severity:** `high`. It is the first thing every student does, and the product answers a completed action by showing them the page they started on.
- **Decision needed:** `fix`. Point the callback at the stage resolver the sign-in route already uses.
- **Raised by:** [`portal/sign-in.md`](portal/sign-in.md#open-questions-and-verification)

### B-00a: A partial GitHub outage silently shortens the repository list

- **Where the user meets it:** A student opening the Start path during a GitHub incident sees fewer repositories than they have, or none, and is told there are none.
- **What happens / what was expected:** A failure fetching one installation's repositories is caught and returned as an empty list, so the student gets a 200 and possibly the "No repositories are visible yet." card. That directly contradicts the deliberate loud failure one layer up, whose comment says an empty success "told the student their fork was missing during a GitHub outage." Expected: the same loud failure, for the same stated reason.
- **Reproduce:** Make one installation's repository listing fail while another succeeds, then open `/connect`.
- **Why (from the code):** `apps/portal/worker/github/client.ts:207` swallows the per-installation error; the loud path it contradicts is `apps/portal/worker/routes/github.ts:120`.
- **Severity:** `high`. It sends a student to re-fork a repository they already have, and the codebase already decided this exact question the other way.
- **Decision needed:** `fix`.
- **Fixed on `fix/demo-readiness`:** the per-installation catch is gone, so the failure reaches the loud path it contradicted (`apps/portal/worker/github/client.ts:209`). Covered by two route-level tests that drive the real client against a stubbed 401 and 500 (`apps/portal/test/github-connect.test.ts`).
- **Raised by:** [`portal/connect-a-repository.md`](portal/connect-a-repository.md#open-questions-and-verification)

### B-01: Week 1 scores student code under a randomized hash seed, and the guard test cannot see it

- **Where the user meets it:** A Week 1 team runs the same commit twice and gets two different scores, with nothing on either run page suggesting the platform did anything differently.
- **What happens / what was expected:** `week2_image` and `week3_image` both set `PYTHONHASHSEED=0`, with a measured reason: one team's text score moved between 0.8188 and 0.8335 across three seeds. `week1_image` sets `PYTHONPATH` and `MPLBACKEND` and not the seed, so Week 1 student code runs unpinned. Expected: every image that executes student code pins the seed, which is what the guard test's docstring says is required.
- **Reproduce:** Start two hosted practice runs on the same Week 1 commit and compare the primary metric. A repository whose result depends on set or dict iteration order is needed to see it; the CLI pins the seed locally, so the difference only appears hosted.
- **Why (from the code):** `apps/runner-modal/src/cogworks_runner/modal_app.py:282` against `:168` and `:227`. The test meant to catch it, `apps/runner-modal/tests/test_prepare_rungs.py:224`, filters `.env` blocks to those containing `MPLBACKEND` with an embedded newline. It was written to exclude the controller image, but the controller image never calls `.env` at all, so the filter excludes `week1_image` instead. Three blocks exist, the assertion expects two, and it passes.
- **Severity:** `high`. It makes a published number irreproducible, and the test that exists to prevent it reports success.
- **Decision needed:** `fix`. Add the seed to `week1_image` and rewrite the test's filter to select images by what they are rather than by a whitespace heuristic.
- **Raised by:** [`sandbox/prepare.md`](sandbox/prepare.md#open-questions-and-verification)

### B-02: Linking a device before joining a team destroys the code after ten silent minutes

- **Where the user meets it:** A student who finds the CLI before finishing the browser flow runs `cogworks link`, opens the URL, and is bounced somewhere else. The terminal keeps waiting.
- **What happens / what was expected:** `POST /v1/cli/device/approve` requires a team, so the stage gate redirects the browser to `/join` or `/connect` and the approval never happens. The browser side names the loss (`apps/portal/src/components/DroppedLinkNotice.tsx:23`); the terminal is told nothing and polls for the full ten minutes before printing "The device link expired before it was approved." Expected: the terminal learns the code was dropped, or the approval page holds the code across the gate.
- **Reproduce:** Sign in with a fresh account, do not join a cohort or team, run `cogworks link --portal <origin>`, open the URL, and watch both halves.
- **Why (from the code):** `apps/portal/worker/routes/connections.ts:171` calls `requireTeam` on approve. `python/cogbench/src/cogbench/client.py:78` polls until `expiresAt` with no way to learn the code was consumed or dropped.
- **Severity:** `high`. Ten minutes of a student's time, no information, and `link` is one of the first commands they run.
- **Decision needed:** `fix`. Half of this is already fixed on the browser side; the terminal needs the other half, which is a distinguishable poll response for a dropped code.
- **Raised by:** [`terminal/link.md`](terminal/link.md#open-questions-and-verification), [`foundations/identity-and-roles.md`](foundations/identity-and-roles.md#open-questions-and-verification)

### B-04: The "supplied" disclosure never reaches the hosted run page

- **Where the user meets it:** A student reads a hosted run page and cannot tell whether their score was computed with resources the benchmark handed their code, such as GloVe vectors or an id-to-name table over the enrolled songs.
- **What happens / what was expected:** The disclosure is built during discovery and written into the sandbox's discovery file. Nothing on the wire between the sandbox and the portal carries it: the refusal reader takes only the verdict, and the wiring reader takes only stage, function, received, and returned. Searching `apps/portal/src` and `packages/contracts/src` for the word finds nothing. Expected: the code comment says outright that a run page shows this under "supplied", and the terminal does show it.
- **Reproduce:** Run `cogworks check` on a Week 3 repository and read the supplied lines, then start a hosted run on the same commit and compare the run page.
- **Why (from the code):** `python/cogbench/src/cogbench/resolve.py:271` states the claim; `apps/runner-modal/src/cogworks_runner/modal_app.py` `_refusal_from` and `_collect_wiring` do not carry it, and no contract field exists for it.
- **Severity:** `high`. A score computed with a benchmark-supplied resource is a different claim from one computed without it, which is the platform's own stated reason for building the disclosure. Hosted numbers are the ones that reach a leaderboard.
- **Decision needed:** `fix`. Add the field to the wiring contract and render it, or delete the comment and accept that only the local report discloses it.
- **Raised by:** [`cross-cutting/what-the-benchmark-supplied.md`](cross-cutting/what-the-benchmark-supplied.md#open-questions-and-verification), [`sandbox/discovery.md`](sandbox/discovery.md#open-questions-and-verification), [`foundations/what-the-portal-claims.md`](foundations/what-the-portal-claims.md#open-questions-and-verification)

### B-05: `cogworks run --live` checks its preconditions after the ninety-second search

- **Where the user meets it:** A student runs `cogworks run --benchmark <id> --live`, waits through the whole discovery search, and is then told they cannot use `--live`.
- **What happens / what was expected:** `_submission_for` runs first, then `_start_live_run`. Both of the live preconditions ("This portal is not linked. Run `cogworks link` first." and "Live sharing requires a committed GitHub repository.") are checked after the expensive part, and nothing is saved when they fail. Expected: an argument that cannot work is refused before any work.
- **Reproduce:** In an unlinked checkout of a repository whose search is slow, run `cogworks run --benchmark <id> --live` and time it to the error.
- **Why (from the code):** `python/cogbench/src/cogbench/cli.py:617` runs the search; `:620` starts the live session. The search cost is measured in `python/cogbench/src/cogbench/progress.py`, where one 2026 repository resolves in 3962 pairings over about ninety seconds.
- **Severity:** `high`. Pure ordering, entirely wasted time, and it happens on the command a student runs most.
- **Decision needed:** `fix`. Resolve the portal, the token, and the repository state before loading the benchmark.
- **Raised by:** [`terminal/run.md`](terminal/run.md#open-questions-and-verification)

### B-06: Changing the repository rewrites what every earlier run page claims

- **Where the user meets it:** A team switches the connected repository. Every run page from before the switch now shows the new repository's name above the old repository's commit.
- **What happens / what was expected:** The run detail serializer builds its repository block from the team row rather than from the run's own `repositoryId`. Expected: a run describes the repository it actually ran against, which is what the confirmation "history stays with the team" implies is being preserved.
- **Reproduce:** Run a practice benchmark, note the run page's repository and SHA, change the repository from the team page, then reopen the run page.
- **Why (from the code):** `apps/portal/worker/http/serializers.ts:125`.
- **Severity:** `high`. Silently wrong about the past, in the one place a student goes to understand a result, and the pairing of a name with a foreign SHA is actively misleading.
- **Decision needed:** `fix`. Serialize from the run's own repository reference.
- **Raised by:** [`foundations/the-team-and-the-repository.md`](foundations/the-team-and-the-repository.md#open-questions-and-verification), [`portal/the-team-page.md`](portal/the-team-page.md#open-questions-and-verification)

### B-07: Nothing lets a student leave a team, and only the creator can let them out

- **Where the user meets it:** A student joins the wrong team, or is added to one by mistake, and finds no way out.
- **What happens / what was expected:** No control anywhere in the product removes a member from their own team. `DELETE /team/members/:login` is admin-only and refuses the admin, so a creator cannot leave at all and a member can only be let out by their creator. The unique index on `team_members.userId` means one team at a time. Meanwhile one error sentence assumes the student can act: "You're on a team in your current cohort. Leave it before joining a different cohort."
- **Reproduce:** Join a team, then look for any way to leave it in the portal, the CLI, or Discord.
- **Why (from the code):** `apps/portal/worker/db/schema.ts:192` (the unique index), `apps/portal/worker/routes/team-membership.ts:294` (the admin refusal), `apps/portal/worker/routes/cohorts.ts:34` (the sentence that assumes otherwise).
- **Severity:** `high`. A one-way door that needs an instructor to open, on a platform whose users are seventeen and will make this mistake.
- **Decision needed:** `product call`. Either add a leave control with a stated consequence, or change the cohort sentence so it does not promise something that does not exist. The first costs a confirm dialog and a decision about what happens to the team's history; the second costs one string and leaves the door shut.
- **Raised by:** [`portal/the-team-page.md`](portal/the-team-page.md#open-questions-and-verification), [`foundations/the-team-and-the-repository.md`](foundations/the-team-and-the-repository.md#open-questions-and-verification), [`portal/join-or-make-a-team.md`](portal/join-or-make-a-team.md#open-questions-and-verification)

### B-08: Uploaded weights are keyed to a commit, and nothing tells the student that

- **Where the user meets it:** A Week 3 team follows the platform's own advice, syncs their weights, pushes one more commit, starts a hosted run, and gets a withheld overall again with no explanation.
- **What happens / what was expected:** Weights are stored under `weights/{repository}/{commit}/{path}` and a hosted run lists only the ones filed under its own commit, so a sync is bound to the exact revision the local run used. The Week 3 diagnostic that sends teams down this path now says "Keep the weights your training run produces out of git. Then run `cogworks run` locally and `cogworks sync`; the hosted run will fetch the weights the local run used." Nothing in that sentence, on the dashboard, or on the run page mentions the commit. Expected: either the student is told, or the pairing survives a commit that did not touch the weights.
- **Reproduce:** Run locally, sync, commit anything, push, start a hosted run, and compare the metrics with a hosted run at the synced commit.
- **Why (from the code):** `apps/portal/worker/services/weights.ts` (`weightPrefix`, `listWeights`); the job is built from that list at `apps/portal/worker/execution/runner.ts:61`; the advice is `weights_diagnostic` in `benchmarks/week3/language_search_benchmark/roles.py`.
- **Severity:** `high`. The failure is silent, it looks identical to never having synced, and it lands on the one week that depends on this path.
- **Decision needed:** `product call`. Saying so in the diagnostic is one sentence. Making the pairing survive a commit means keying on something other than the revision, which weakens the guarantee that the weights match the code that produced them.
- **Raised by:** [`terminal/sync.md`](terminal/sync.md#open-questions-and-verification), [`sandbox/prepare.md`](sandbox/prepare.md#open-questions-and-verification)

### B-09: The weight upload has a fifteen-second timeout and a two-hundred-megabyte ceiling

- **Where the user meets it:** A student syncs a real training checkpoint. The command sits silent, then fails.
- **What happens / what was expected:** The portal accepts a weight file up to 200 MiB and enforces that twice. The CLI reads the file into memory whole and sends it as one `PUT` with a 15 second timeout, no retry, and no progress output. Expected: two numbers that can both be true at once. A file anywhere near the ceiling cannot transfer inside the timeout on an ordinary connection, and nothing is on screen while it tries.
- **Reproduce:** Sync a report naming an untracked weight file of a few hundred megabytes and time it.
- **Why (from the code):** `MAX_WEIGHT_BYTES` in `packages/contracts/src/protocol.ts`, enforced in `apps/portal/worker/services/weights.ts`; the client's timeout and whole-file read are in `python/cogbench/src/cogbench/client.py:158`.
- **Severity:** `high`. It affects exactly the students the feature was built for, and the failure is a long silence followed by an error.
- **Decision needed:** `fix`. Stream the upload, set a timeout proportional to the ceiling, and print a line per file. Whether a real Week 3 checkpoint approaches 200 MiB was not measured, and this entry should not pretend otherwise.
- **Raised by:** [`terminal/sync.md`](terminal/sync.md#open-questions-and-verification)

### B-09a: The Week 3 withheld sentence is cut off mid-word before the student reads it

- **Where the user meets it:** A Week 3 team whose image side did not bind opens their run page. The first sentence, set large, stops in the middle of a word.
- **What happens / what was expected:** Diagnostics are capped at 240 characters each, and the withheld sentence is inserted at position zero so it leads the page. The current no-save-call form runs to 366 characters and the common form to 311, losing 126 and 71 characters respectively, cutting inside the copyable command each one ends with. Expected: the sentence a benchmark writes to lead a run page fits the field that carries it.
- **Reproduce:** Start a hosted Week 3 run on a repository with no trained weights and read the finding.
- **Why (from the code):** the 240-character cap is applied where diagnostics are assembled (`apps/runner-modal/src/cogworks_runner/modal_app.py:2334`) and again in the wire schema; the sentences are built in `weights_diagnostic` in `benchmarks/week3/language_search_benchmark/roles.py` and at `plugins.py:563`.
- **Severity:** `high`. It is the most important sentence Week 3 produces, it is the one the platform's own design says should lead, and it arrives truncated.
- **Decision needed:** `fix`. Either raise the cap for the leading diagnostic or shorten the sentence. In flight: the sentence grew during this pass, which is what pushed it past the limit.
- **Raised by:** [`sandbox/scoring-and-refusals.md`](sandbox/scoring-and-refusals.md#open-questions-and-verification)

### B-09b: Discord tells a student a hosted practice run is free

- **Where the user meets it:** A student presses "Verify hosted" in Discord and reads a confirmation saying it costs nothing. It costs one of ten.
- **What happens / what was expected:** The confirmation reads "The hosted bench runs this exact commit, so the score is observed, not self-reported. It's practice and spends nothing." The action calls `startPracticeRun`, which the ten-run practice quota counts. The browser's equivalent control says the opposite, correctly. Expected: the two surfaces agree, and neither calls an action free when it is not.
- **Reproduce:** Run `/cog`, choose "Verify hosted", read the confirmation, and compare the dashboard's practice counter before and after.
- **Why (from the code):** `apps/discord-bot/src/commands.ts:514`; the quota is counted at `apps/portal/worker/services/run-actions.ts:206`.
- **Severity:** `high`. A confirmation dialog that misstates the cost of the thing it is confirming, on the surface where the student is least able to see the counter.
- **Decision needed:** `fix`.
- **Raised by:** [`cross-cutting/credit-and-quota.md`](cross-cutting/credit-and-quota.md#open-questions-and-verification), [`discord/commands.md`](discord/commands.md#open-questions-and-verification)

### B-09c: The admin console counts quota differently from the quota

- **Where the user meets it:** An instructor opens the admin page and reads a team's usage as "11/10".
- **What happens / what was expected:** The admin overview counts every practice run and every official attempt a team has made, across all benchmarks and all versions. The limits it prints them against are per team per benchmark version. A team six runs into Recognition and five into Clustering displays eleven against a limit of ten. Expected: numerator and denominator measure the same thing. The denominators are also hardcoded, which is B-35.
- **Reproduce:** Give one team runs on two benchmarks in the same week and open `/admin`.
- **Why (from the code):** `apps/portal/worker/routes/admin.ts:76` and `:80` count without grouping; the limits are applied per benchmark version at `apps/portal/worker/services/run-actions.ts:206` and `:347`.
- **Severity:** `high`. It is the first number an instructor reads about a team, it can exceed its own maximum, and an instructor acting on it would draw the wrong conclusion about who is stuck.
- **Decision needed:** `fix`.
- **Raised by:** [`portal/admin.md`](portal/admin.md#open-questions-and-verification)

### B-10: `cogworks check` can exit 0 on a repository `cogworks run` refuses

- **Where the user meets it:** A student runs `cogworks check`, is told their code is wired up and ready, runs the command the report ends with, and is told nothing here can be scored.
- **What happens / what was expected:** With an installed submission entry point and a benchmark that has no discovery spec, `_check` leaves `submissionLoadable` true and prints "Your submission is registered as an installed package, so it was used as is.", while `_submission_for` deliberately ignores entry points and raises "Nothing in this repository could be scored yet." Expected: the two agree, which is exactly what `_submission_for`'s own docstring says must hold.
- **Reproduce:** In a checkout with a submission package pip-installed from a different week's repository, run `cogworks check` then `cogworks run` for a benchmark with no discovery spec.
- **Why (from the code):** `python/cogbench/src/cogbench/cli.py:351` never runs in that branch; `:281` raises. The docstring naming this as the thing that must not happen is at `:253`.
- **Severity:** `high`. It is the specific lie the code was restructured to prevent, and a student who hits it has been told two contradictory things by one tool.
- **Decision needed:** `fix`. Make `_check` apply the same file-wins rule `_submission_for` uses.
- **Fixed on `fix/demo-readiness`:** both commands read one decision, `_scoreable` (`python/cogbench/src/cogbench/cli.py:323`), and an installed entry point is reported without being counted as readiness. Covered by `python/cogbench/tests/test_cli_readiness.py`.
- **Raised by:** [`terminal/check.md`](terminal/check.md#open-questions-and-verification)

### B-11: Week 2 never attributes a timeout, so a killed run spends an attempt under the wrong category

- **Where the user meets it:** A Week 2 team's official run is killed at the fifteen-minute ceiling. They are shown a generic evaluation failure with a truncated stderr tail, and the attempt is spent.
- **What happens / what was expected:** `_evaluate_week1` and `_evaluate_week3` record a start time and call `_timed_out` before falling through to `student_runtime`. `_evaluate_v2` and `_evaluate` do neither, so a SIGKILL at the budget is reported as an ordinary runtime failure. Expected: the same attribution every other lane performs, which exists specifically to give the student the timeout message with its advice about work that grows with the catalog.
- **Reproduce:** Submit a Week 2 repository whose evaluation exceeds 900 seconds and read the failure card.
- **Why (from the code):** `apps/runner-modal/src/cogworks_runner/modal_app.py` `_evaluate_v2` and `_evaluate` against `_evaluate_week1` and `_evaluate_week3`; `_timed_out` is the function they skip. `apps/runner-modal/tests/test_limit_attribution.py` asserts every `_evaluate*` path classifies both limits, which is worth re-reading, because either the test or the code is wrong.
- **Severity:** `high`. Both outcomes spend the attempt, so the cost is identical, but the student is denied the one message that would tell them what to change.
- **Decision needed:** `fix`.
- **Raised by:** [`sandbox/timeouts-and-limits.md`](sandbox/timeouts-and-limits.md#open-questions-and-verification)

### B-12: `/cog view:connect` for an already-linked student is a dead end

- **Where the user meets it:** A student who has already linked Discord picks "Connect account" from the `/cog` menu, and gets a card telling them to do something in the portal with no way to reach it.
- **What happens / what was expected:** The already-linked branch returns the home view without passing the portal origin, so the home view falls into its no-origin branch: a single "Refresh" button, no "Open Cog\*Portal" link. When the student is also teamless, the card reads "Choose your team's repository in Cog\*Portal" while offering nothing that goes there. Expected: the link is present, as it is on every other path to the same card.
- **Reproduce:** Link Discord, do not join a team, then run `/cog view:connect`.
- **Why (from the code):** `apps/discord-bot/src/commands.ts:235` omits the fifth argument; the no-origin branch is at `:106`.
- **Severity:** `high`. A dead end whose own text names the action it will not let the student take.
- **Decision needed:** `fix`. One argument.
- **Raised by:** [`discord/commands.md`](discord/commands.md#open-questions-and-verification)

### B-13: An interrupted `--live` run leaves the session running and the team's bubble frozen forever

- **Where the user meets it:** A student kills a `cogworks run --live`, or their laptop sleeps. The bubble in the team channel stays on a live loader indefinitely, and teammates see a run that never finishes.
- **What happens / what was expected:** A hard kill sends no terminal event. Nothing sweeps `local_run_sessions`; the maintenance cron covers hosted runs only. Expected: an abandoned local session ages out the way a stale hosted run does.
- **Reproduce:** Start `cogworks run --benchmark <id> --live`, `kill -9` the process, and watch the channel.
- **Why (from the code):** `apps/portal/worker/execution/maintenance.ts:53` selects only from `runs`. The CLI's own Ctrl+C path does send a failure event, so this is specifically about kills the process cannot catch.
- **Severity:** `high`. It is visible to the whole team, it is permanent, and the student who caused it has no way to clear it.
- **Decision needed:** `fix`. Age out a local session with no event for some multiple of the two-second heartbeat.
- **Raised by:** [`terminal/run.md`](terminal/run.md#open-questions-and-verification), [`discord/channel-messages.md`](discord/channel-messages.md#open-questions-and-verification), [`cross-cutting/live-updates.md`](cross-cutting/live-updates.md#open-questions-and-verification)

### B-14: One member's expired GitHub token blanks the team's process panel for thirty minutes

- **Where the user meets it:** A team opens the team page and is told their commit history could not be read, for half an hour, because one teammate opened the page first.
- **What happens / what was expected:** The process signals are cached per team for thirty minutes, but computing them uses the GitHub token of whoever asked. A caller with no token or an expired one produces the fetch-failure state, and that state is what gets cached for everybody. Expected: a failure that belongs to one caller's credentials is not cached as a fact about the team.
- **Reproduce:** Have a member whose GitHub token has expired open `/team`, then have the creator open it within thirty minutes.
- **Why (from the code):** `apps/portal/worker/routes/team.ts:276` reads the cache; `:295` takes the token from the caller; `:199` sets the thirty-minute window.
- **Severity:** `high`. It presents a credential problem as an observation about the team, which is the class of claim this platform is most careful about elsewhere.
- **Decision needed:** `fix`. Do not cache a fetch failure, or cache it separately from a successful reading.
- **Raised by:** [`portal/the-team-page.md`](portal/the-team-page.md#open-questions-and-verification)

## Medium

### B-03: Two gates disagree about which team members Discord serves

- **Where the user meets it:** Nobody, today. This is a latent divergence, filed because the two halves are one screen apart and the day a fourth role exists it becomes B-03 as originally written: a permanent dead end whose message says the portal is unreachable.
- **What happens / what was expected:** `getDiscordTeamStatus` accepts any membership row, so the bot proceeds as though any member has a team. The `home` view then calls `getRunSurface`, which resolves the actor through `discordRunActor` and throws 403 "Current write access to the team repository is required." for any role outside `admin`, `maintain`, `write`. The bot's error handler turns that into "I couldn't reach Cog\*Portal just now." Expected: one answer to "may this member use Discord".
- **Why it is not reachable now:** `teamRole` maps GitHub `read` and `triage` to null and refuses the join, and a demoted admin is rewritten to `write` rather than to something lower (`apps/portal/worker/github/permissions.ts:3`, `apps/portal/worker/routes/team.ts:165`). No write path can store a role outside the three the actor check allows. The break would also be narrower than a total lockout: only `home` calls `getRunSurface`, so leaderboard, benchmarks, and local notes would still render.
- **Why (from the code):** `apps/portal/worker/services/discord.ts:154` against `apps/portal/worker/services/run-actions.ts:68`; the collapse is at `apps/discord-bot/src/index.ts:46`.
- **Severity:** `medium`, downgraded from high after the role gate was traced. Two components disagree about the same rule, and nothing fails a build if one changes.
- **Decision needed:** `fix`. Make the Discord status check use the same role predicate the actor check uses, so the two cannot drift.
- **Raised by:** [`discord/commands.md`](discord/commands.md#open-questions-and-verification), [`foundations/the-team-and-the-repository.md`](foundations/the-team-and-the-repository.md#open-questions-and-verification)

### B-15: Re-linking a device accumulates live tokens that nothing revokes

- **Where the user meets it:** After a few dropped link attempts, the connections page lists three or four identical `CogWorks CLI` devices and the student cannot tell which one their terminal holds.
- **What happens / what was expected:** Every completed handshake inserts a new device row. Nothing revokes the previous one, and each survives its full sixty-day life. Expected: re-linking the same machine replaces its token, or the list distinguishes them.
- **Why (from the code):** `apps/portal/worker/routes/connections.ts:259` inserts unconditionally. The name defaults to `CogWorks CLI` for every one.
- **Severity:** `medium`. Recoverable by revoking all of them and linking again, but the student has to guess.
- **Decision needed:** `fix`.
- **Raised by:** [`terminal/link.md`](terminal/link.md#open-questions-and-verification)

### B-16: `check --update-setup` is silently ignored when the check does not pass

- **Where the user meets it:** A student copies the exact command from the setup page, the check reports a problem, and the setup guide never advances. Nothing says the flag was dropped.
- **What happens / what was expected:** The update is gated on the check exiting 0, with no else branch. Expected: either the flag reports that it did nothing, or the steps that did pass are recorded.
- **Why (from the code):** `python/cogbench/src/cogbench/cli.py:612`.
- **Severity:** `medium`. Confusing at exactly the moment a student is already stuck, but recoverable by fixing the underlying problem.
- **Decision needed:** `fix`. One sentence on stderr would be enough.
- **Raised by:** [`terminal/check.md`](terminal/check.md#open-questions-and-verification), [`portal/setup.md`](portal/setup.md#open-questions-and-verification)

### B-17: The two longest paragraphs in `cogworks check` are the two that are not wrapped

- **Where the user meets it:** A failing check on a narrow terminal breaks mid-package-name in the one part of the report the student is meant to read carefully.
- **What happens / what was expected:** The gap note is wrapped to 78 columns; the verdict headline and next step are appended as single lines. The `could_not_look` headline is about 220 characters. Expected: `_wrapped` applies to them, for the reason its own docstring gives.
- **Why (from the code):** `python/cogbench/src/cogbench/report.py:269` and `:274`; the wrapper and its rationale are at `:40`.
- **Severity:** `medium`. Cosmetic, but it lands on every failing check.
- **Decision needed:** `fix`.
- **Raised by:** [`terminal/check.md`](terminal/check.md#open-questions-and-verification)

### B-18: The most ordinary failure verdict has no next step

- **Where the user meets it:** A student on a fully provisioned machine gets a `not_wired` verdict and no line telling them what to do.
- **What happens / what was expected:** The next step is produced only when a skipped module names a missing package; otherwise it is empty. `report.py`'s stated contract is "either you are ready, or here is the single next thing." Expected: the contract holds, or the report says explicitly that the next step is theirs to find.
- **Why (from the code):** `python/cogbench/src/cogbench/resolve.py:1928` returns `""`; the contract is stated at `python/cogbench/src/cogbench/report.py:9`.
- **Severity:** `medium`. The headline still names the hand-off that failed, which is the actionable part, so this is a missing signpost rather than a missing diagnosis.
- **Decision needed:** `fix`. The honest line here may be that the next step is to read the trace, which is a sentence the platform is allowed to write.
- **Raised by:** [`terminal/check.md`](terminal/check.md#open-questions-and-verification)

### B-19: The Discord bot replaces every actionable portal error with one generic sentence

- **Where the user meets it:** Anything that goes wrong in Discord reads as "I couldn't reach Cog\*Portal just now."
- **What happens / what was expected:** The bot's error handler collapses every thrown error. The messages it discards include the bot-permissions instruction, "That channel already belongs to {name}.", "A team creator or maintainer needs to choose the team channel.", and "The official-attempt quota is exhausted." The Discord Activity surfaces the same errors verbatim, so the two surfaces disagree about what the student is told. Expected: an error the portal wrote for a reader reaches the reader.
- **Why (from the code):** `apps/discord-bot/src/index.ts:46` and `:138`; the Activity's behavior is at `apps/portal/src/activity-main.tsx:54`.
- **Severity:** `medium`. It is the root cause behind B-03 and behind several smaller confusions, and it makes the bot untriageable from a student report.
- **Decision needed:** `fix`. Pass through the portal's message for known error codes and keep the generic sentence for transport failures, which is what it was written for.
- **Raised by:** [`discord/commands.md`](discord/commands.md#open-questions-and-verification), [`cross-cutting/refusals-and-disclosure.md`](cross-cutting/refusals-and-disclosure.md#open-questions-and-verification)

### B-20: The live run surface is unreachable from the portal and has no way out

- **Where the user meets it:** A student who arrives at `/run-surfaces/{id}` from Discord or the CLI finishes reading and finds no navigation anywhere on the page.
- **What happens / what was expected:** Nothing in the portal links to the route; only the Activity's separate entry point constructs the URL. The success state has no link out at all, and "Back to dashboard" exists only in the error branch. Expected: a page a student can reach is a page they can leave.
- **Why (from the code):** `apps/portal/src/routes/RunSurfacePage.tsx:27`.
- **Severity:** `medium`. The browser back button works, so it is a dead end only in the sense that the page offers nothing.
- **Decision needed:** `product call`. Either link the surface from the dashboard's run list and give it navigation, or accept that it is an embedded view and give it navigation anyway.
- **Raised by:** [`portal/watching-a-run.md`](portal/watching-a-run.md#open-questions-and-verification)

### B-21: A plugin version mismatch is reported to the student as missing benchmark data

- **Where the user meets it:** A run fails with "Benchmark data is not ready" and an explanation about a data bundle that could not be downloaded or did not match its checksum, when the real problem is that the deployed plugin and the run job disagree about a version.
- **What happens / what was expected:** The contract check raises the mismatch under the `data_download` category, which maps to that copy. Expected: `contract_invalid` or `provider`, either of which is true.
- **Why (from the code):** `apps/runner-modal/src/cogworks_runner/modal_app.py:926`; the copy is in `packages/contracts/src/failures.ts`. `apps/runner-modal/tests/test_preflight_dispatch.py:402` documents this drift being seen in production.
- **Severity:** `medium`. The run is refunded either way, so nothing is lost but the student's and the instructor's time chasing the wrong thing.
- **Decision needed:** `fix`.
- **Raised by:** [`sandbox/scoring-and-refusals.md`](sandbox/scoring-and-refusals.md#open-questions-and-verification), [`foundations/the-run.md`](foundations/the-run.md#open-questions-and-verification)

### B-22: The evaluation progress counter never moves

- **Where the user meets it:** Watching a run, the student sees "0 of N cases" for the whole of the longest phase, then N of N.
- **What happens / what was expected:** The sandbox reports zero at the start, the heartbeat repeats zero, and the only other value is the terminal one. The wire field carries `unit: "cases"`, which implies per-case reporting the sandbox never provides. The CLI's local run does the same thing. Expected: either real progress, or no counter, since a bar that does not move reads as a hang.
- **Why (from the code):** `apps/runner-modal/src/cogworks_runner/modal_app.py:2293` and `:2294`; `python/cogbench/src/cogbench/runner.py:84`.
- **Severity:** `medium`. It is the phase most likely to make a student think the platform has stopped, which is the exact failure the CLI's own progress module was written to prevent.
- **Decision needed:** `fix`.
- **Raised by:** [`portal/watching-a-run.md`](portal/watching-a-run.md#open-questions-and-verification), [`cross-cutting/live-updates.md`](cross-cutting/live-updates.md#open-questions-and-verification), [`terminal/run.md`](terminal/run.md#open-questions-and-verification)

### B-23: Promote is clickable while the quota is still loading

- **Where the user meets it:** A student opens a run page, clicks "Promote to official" before the dashboard query resolves, and gets a server error instead of a disabled button.
- **What happens / what was expected:** The disabled state is gated on the quota having loaded, so an undefined quota leaves the button enabled. Expected: pending is treated as unknown and the button waits.
- **Why (from the code):** `apps/portal/src/routes/RunDetailPage.tsx:280`.
- **Severity:** `medium`. The server refuses correctly, so nothing is spent; the student sees an error that was avoidable.
- **Decision needed:** `fix`.
- **Raised by:** [`portal/promote-to-the-leaderboard.md`](portal/promote-to-the-leaderboard.md#open-questions-and-verification)

### B-24: The refund cap is bypassed when Modal dispatch fails

- **Where the user meets it:** Invisibly, in the accounting. A team whose runs keep failing to dispatch gets unlimited free attempts, and the admin console's refund count does not show them.
- **What happens / what was expected:** A pre-acceptance dispatch failure deletes the official attempt row directly, without stamping `refundedAt`, so it is invisible both to the cap calculation and to the staff view. Expected: every refund goes through the one function that counts them.
- **Why (from the code):** `apps/portal/worker/services/run-actions.ts:172` against `apps/portal/worker/execution/refunds.ts:122`.
- **Severity:** `medium`. It favours the student, so nobody is harmed, but the cap exists for a reason and this path ignores it.
- **Decision needed:** `fix`.
- **Raised by:** [`cross-cutting/credit-and-quota.md`](cross-cutting/credit-and-quota.md#open-questions-and-verification)

### B-25: The Week 3 timeout message is Week 1's copy, about songs

- **Where the user meets it:** A `language-search` team times out and reads advice about enrolling every song and a database that grows with the catalog. Week 3 has captions, descriptors, and image ids.
- **What happens / what was expected:** The two messages are byte-identical. Expected: Week 3's message describes Week 3's work.
- **Why (from the code):** `apps/runner-modal/src/cogworks_runner/modal_app.py:1917` against `:1996`.
- **Severity:** `medium`. The general advice still applies, so it is not wrong so much as addressed to somebody else, which undermines trust in the rest of the failure card.
- **Decision needed:** `fix`.
- **Raised by:** [`sandbox/timeouts-and-limits.md`](sandbox/timeouts-and-limits.md#open-questions-and-verification)

### B-26: Floors print as ordinary scores in the terminal

- **Where the user meets it:** A Week 3 student reads a local report and cannot tell "Chance MRR" from "Text MRR". Both are printed the same way.
- **What happens / what was expected:** The metric reader drops `role` and `relatesTo`, and the local report renderer treats every metric identically with no primary marker and no floor rendering. Expected: the terminal makes the same distinction the run page does, which exists precisely because "higher is better" on a floor reads as advice to raise a number the student does not control.
- **Why (from the code):** `python/cogbench/src/cogbench/models.py:62` (`from_wire` drops the fields), `python/cogbench/src/cogbench/cli.py:166` (`_print_report`), and `python/cogbench/src/cogbench/runner.py:167` (the local runner never sets them).
- **Severity:** `medium`. It contradicts a rule the platform states explicitly and enforces in the browser.
- **Decision needed:** `fix`.
- **Raised by:** [`terminal/report.md`](terminal/report.md#open-questions-and-verification), [`terminal/run.md`](terminal/run.md#open-questions-and-verification)

### B-27: A batch of live events applies partially and reports failure

- **Where the user meets it:** After a flaky `--live` run, the team's bubble holds some of the run's events and the CLI was told the batch failed.
- **What happens / what was expected:** The batch handler loops sequentially, so a throw on event n leaves events 0 to n-1 applied and returns a 4xx. Expected: the batch is atomic, or the response says how far it got.
- **Why (from the code):** `apps/portal/worker/routes/local-runs.ts:380`.
- **Severity:** `medium`. The sequence guard makes a retry mostly safe, which is why this is not high, but the CLI's retry semantics depend on that accident rather than on the contract.
- **Decision needed:** `fix`.
- **Raised by:** [`cross-cutting/live-updates.md`](cross-cutting/live-updates.md#open-questions-and-verification)

### B-28: The connections page polls forever while no device is linked

- **Where the user meets it:** A student sitting on `/connections` during a link, which is exactly when they are told to sit there.
- **What happens / what was expected:** The query refetches every four seconds and only stops once at least one device exists. A student who never completes a link never stops requesting. Expected: the poll backs off or stops after a bounded window.
- **Why (from the code):** `apps/portal/src/lib/queries.ts:120`.
- **Severity:** `medium`. Battery and request volume rather than correctness.
- **Decision needed:** `fix`.
- **Raised by:** [`foundations/the-ask.md`](foundations/the-ask.md#open-questions-and-verification), [`terminal/link.md`](terminal/link.md#open-questions-and-verification), [`cross-cutting/live-updates.md`](cross-cutting/live-updates.md#open-questions-and-verification)

### B-29: A member added from the team page gets write access the portal never checked

- **Where the user meets it:** An admin adds a teammate from the team page. The add succeeds. The teammate is refused later, at run time, with a message about GitHub permission.
- **What happens / what was expected:** Adding from the team page writes the `write` role unconditionally, while `POST /team/join` reads GitHub first. Expected: the same check, so the refusal arrives on the screen where the admin who can fix it is standing.
- **Why (from the code):** `apps/portal/worker/routes/team-membership.ts:251` against `:159`; the later refusal is `apps/portal/worker/services/run-actions.ts:98`.
- **Severity:** `medium`. Recoverable, but the error surfaces one screen and one person away from the fix.
- **Decision needed:** `fix`.
- **Raised by:** [`foundations/identity-and-roles.md`](foundations/identity-and-roles.md#open-questions-and-verification)

### B-30: Co-author credit reaches half the process panel

- **Where the user meets it:** On the team page, the stage rail credits both people on a paired commit while the contract-file list beside it credits only one.
- **What happens / what was expected:** The stage footprint and ownership breadth were changed to read `Co-authored-by:` trailers; the churn event still records one author. Expected: one answer to "who wrote this commit" within one panel.
- **Why (from the code):** `apps/portal/worker/services/process-signals.ts:249` against `:422`.
- **Severity:** `medium`. In flight, and it looks like an unfinished edit rather than a decision.
- **Decision needed:** `fix`.
- **Raised by:** [`portal/the-team-page.md`](portal/the-team-page.md#open-questions-and-verification)

### B-31: Inactive benchmarks are publicly listed and their leaderboard tabs are clickable

- **Where the user meets it:** Anyone, signed in or not, can read the title and summary of a week that has not opened yet, and can click into its standings.
- **What happens / what was expected:** The catalog has no active filter and its route is unauthenticated. The leaderboard computes which tracks are available and then never disables the tab; for Vision it renders the overall standings unconditionally, firing the family query even when neither vision benchmark is active. Expected: an unreleased week is not advertised, and a tab annotated "in progress" does not respond.
- **Why (from the code):** `apps/portal/worker/services/catalog.ts` (no filter), `apps/portal/src/routes/LeaderboardPage.tsx:60` and `:148`.
- **Severity:** `medium`. No data leaks beyond a title and a summary, but it undercuts the instructor's control over when a week opens.
- **Decision needed:** `fix`.
- **Raised by:** [`portal/the-leaderboard.md`](portal/the-leaderboard.md#open-questions-and-verification)

## Low

### B-32: The device has two different names

- `cogworks link` prints the machine's hostname; the portal and `cogworks status` show the name the student typed in the browser. Two names for one device, in two places a student compares.
- **Why:** `python/cogbench/src/cogbench/cli.py:668` against `apps/portal/src/routes/ConnectionsPage.tsx:33`.
- **Severity:** `low`. **Decision needed:** `fix`.
- **Raised by:** [`terminal/link.md`](terminal/link.md#open-questions-and-verification), [`terminal/status.md`](terminal/status.md#open-questions-and-verification)

### B-33: `--json` output is interleaved with a plain-text line

- `check --json --update-setup` and `run --json --update-setup` print "setup: updated ..." to stdout after the JSON document, so the stream is no longer parseable. Every other status line in the CLI goes to stderr.
- **Why:** `python/cogbench/src/cogbench/cli.py:158`.
- **Severity:** `low`, because the combination is unusual. **Decision needed:** `fix`. Send it to stderr like everything else.
- **Raised by:** [`terminal/run.md`](terminal/run.md#open-questions-and-verification), [`terminal/check.md`](terminal/check.md#open-questions-and-verification)

### B-34: A malformed response gives a traceback instead of a sentence

- `cogworks status` reads the seven values by subscript, and `cogworks report` reads a report the same way. `KeyError` is not in the command's caught exception list, so a response or a file missing a field produces a Python stack trace. `subprocess.TimeoutExpired` from the weight-sync git check is outside it too.
- **Why:** the caught tuple at `python/cogbench/src/cogbench/cli.py:720` covers `ContractError`, `PluginError`, `PortalError`, `OSError`, and `ValueError`.
- **Severity:** `low`. It needs a misbehaving portal or a hand-edited file. **Decision needed:** `fix`. Add `KeyError` and `subprocess.SubprocessError` to the tuple.
- **Raised by:** [`terminal/status.md`](terminal/status.md#open-questions-and-verification), [`terminal/report.md`](terminal/report.md#open-questions-and-verification), [`terminal/sync.md`](terminal/sync.md#open-questions-and-verification)

### B-35: The official-attempt limit is hardcoded in five places

- The authority is `OFFICIAL_LIMIT` in `packages/contracts/src/schema.ts:1177`. The admin page writes `/10` and `/3` literally (`apps/portal/src/routes/AdminPage.tsx:437`), the Discord bot writes "of 3" three times (`apps/discord-bot/src/commands.ts:185`, `:521`, `:524`), and the run console writes it once (`apps/portal/src/components/RunConsole.tsx:208`). The dashboard and run page read the real value, so changing the limit produces copy that disagrees with itself across surfaces. `packages/contracts/src/failures.ts` does the same with the fifteen-minute timeout.
- **Severity:** `low` today, because the limits have not changed. **Decision needed:** `fix`.
- **Raised by:** [`cross-cutting/credit-and-quota.md`](cross-cutting/credit-and-quota.md#open-questions-and-verification), [`portal/admin.md`](portal/admin.md#open-questions-and-verification), [`discord/commands.md`](discord/commands.md#open-questions-and-verification)

### B-36: Four user-facing strings use em dashes, which the voice guide bans

- `docs/design/voice.md` bans em dashes in portal copy outright, and calls the dash-as-beat the most recognizable AI-slop tell. Four strings use one anyway:
  - `"Confirm — history stays with the team"` (`apps/portal/src/routes/TeamPage.tsx:404`). The style guide gives this exact string as its own worked example, with the corrected form `"Confirm, history stays with the team"`. The code has the version the guide rejects.
  - `"Confirm — uses attempt N of 3"` (`apps/portal/src/routes/RunDetailPage.tsx`), while the dashboard's equivalent uses a comma.
  - `"No CogPortal account with that GitHub login yet — they need to sign in once first."` (`apps/portal/worker/routes/team-membership.ts:226`).
  - `"I couldn't make a connection link just now. Nothing changed—try again in a moment."` and the same construction in the bot's generic error (`apps/discord-bot/src/commands.ts:236`, `apps/discord-bot/src/index.ts:46`).
- **Severity:** `low`. **Decision needed:** `fix`. Four commas.
- **Raised by:** [`portal/the-team-page.md`](portal/the-team-page.md#open-questions-and-verification), [`portal/promote-to-the-leaderboard.md`](portal/promote-to-the-leaderboard.md#open-questions-and-verification), [`discord/commands.md`](discord/commands.md#open-questions-and-verification)

### B-37: `cancelled` is a status nothing can ever produce

- It is in the database enum, the contract enum, the terminal-status set, the surface projection, and the run console's status chip. No code path writes it and there is no cancel endpoint. A student looking for a way to stop a run finds none, and the phase rail can never reach that state.
- **Why:** `apps/portal/worker/db/schema.ts:294` declares it; nothing sets it.
- **Severity:** `low`. **Decision needed:** `product call`. Either add cancellation, which several surfaces are already drawn for, or remove the status so the code stops implying a feature that does not exist.
- **Raised by:** [`foundations/the-run.md`](foundations/the-run.md#open-questions-and-verification), [`portal/watching-a-run.md`](portal/watching-a-run.md#open-questions-and-verification)

### B-38: Four dead code paths and one tautological test

- `open_portal` has a button label but never appears in the priority list that could select it (`apps/discord-bot/src/commands.ts:159`).
- `open_console` inside `executeCommand` returns "That run action is not available." for a button the product itself generates; only a pre-intercept in `index.ts:104` saves it, so the two files must stay in sync and the fallback is wrong rather than merely unreachable.
- `unlinkDiscord` is implemented end to end and invoked by nothing in the bot, so a student who linked from Discord cannot unlink from Discord.
- `GITHUB_TEAM_VIDEO` is a `null` constant with a TODO, making the walkthrough video component permanently dead (`apps/portal/src/routes/ConnectPage.tsx:32`).
- `apps/discord-bot/test/refusal-message.test.ts:16` asserts `headline.slice(0, 300).length <= 300` on a string literal defined in the test itself. It is true of every string, imports nothing from the product, and leaves the real 300-character cap untested.
- **Severity:** `low`. **Decision needed:** `fix`.
- **Raised by:** [`discord/commands.md`](discord/commands.md#open-questions-and-verification), [`portal/connect-a-repository.md`](portal/connect-a-repository.md#open-questions-and-verification), [`cross-cutting/refusals-and-disclosure.md`](cross-cutting/refusals-and-disclosure.md#open-questions-and-verification)

### B-39: Revoking a device and unlinking Discord have no confirmation

- Both fire on one click (`apps/portal/src/routes/ConnectionsPage.tsx:225`, `:259`), while removing a teammate arms and asks. The irreversible actions have the weaker guard, and the reversible one has the stronger.
- **Severity:** `low`, since re-linking is cheap. **Decision needed:** `fix`, for consistency with the confirm pattern used everywhere else.
- **Raised by:** [`foundations/identity-and-roles.md`](foundations/identity-and-roles.md#open-questions-and-verification)

### B-40: The rail marks every stage done as soon as a result is published

- The lifecycle rail treats `published` as making all four stages complete, regardless of the snapshot's actual stage, so a surface published while its stage is still local or hosted claims the official stage finished. The module's stated purpose is showing observed provenance.
- **Why:** `packages/discord-kit/src/rails.ts:22`.
- **Severity:** `low`. Whether the state is reachable was not established. **Decision needed:** `fix`.
- **Raised by:** [`discord/channel-messages.md`](discord/channel-messages.md#open-questions-and-verification)

### B-41: Small copy and consistency slips

Grouped because each is one string or one line, and none is worth a separate decision.

- `"Failed."` on its own is the shortest error in the product (`apps/portal/src/routes/TeamPage.tsx:327`). It names neither what failed nor what to do, which `docs/design/voice.md` requires of an error. `"Update failed."` and `"Changing the repository failed."` are nearly as bare.
- The connections page labels its device list `COGBENCH DEVICES` (`apps/portal/src/routes/ConnectionsPage.tsx:241`) while every other string in the product says CogWorks CLI. The panel above it says `COGWORKS DEVICE`.
- `RequireStaff` redirects a non-staff visitor silently to `/` (`apps/portal/src/App.tsx:83`) while the matching worker gate answers "Staff access required." A student following a link pasted by a TA cannot tell forbidden from broken.
- "Enter demo mode" navigates to `/dashboard` directly instead of the computed next stage (`apps/portal/src/routes/SignInPage.tsx:138`), so a demo account with no cohort is immediately bounced. Development only.
- The setup guide's entry mode falls back to whether the reader is the team admin when the router state is absent (`apps/portal/src/routes/SetupPage.tsx:46`), so a reload can address a student as though they created a team they joined.
- The setup guide's "Link this machine" step is deliberately unnumbered, so the visible step numbers skip a step while the field-notes rail shows a marker for it. Intentional, and it reads as a gap.
- The dashboard silently degrades its branch dropdown to the default branch alone when the repository list fails or is still loading, and never surfaces that error (`apps/portal/src/routes/DashboardPage.tsx:63`).
- The 900 ms redirect after approving a device is never cleared (`apps/portal/src/routes/ConnectionsPage.tsx:159`), so it can fire after the component unmounts.
- `App.tsx` writes to `sessionStorage` during render rather than in an effect (`:61`, `:67`), and `DroppedLinkNotice` removes its key inside a lazy state initializer, so React's development double-invocation can swallow the notice.
- The Discord activity persists the literal display name `"Discord user"` (`apps/portal/worker/routes/activity.ts:171`), discarding the username it already fetched, while the bot path stores a real identity string.
- The activity authorizes with `prompt: "none"`, so a student who has never authorized the application gets a rejection that lands in the generic error card with no prompt and no retry.
- The connect card promises the link "expires in 10 minutes", which matches the state cookie but not the one-hour activity session.
- The entry-point command declares DM and user-install contexts that the handler then refuses, so a user-installed launch is always a dead end.
- **Severity:** `low`. **Decision needed:** `fix`.
- **Raised by:** most documents in the set.

## What was raised and is not here

Three classes of thing were left out on purpose.

**Unbuilt work.** `RunWorkflow` is a 24-line placeholder that nothing constructs, and the Cloudflare sandbox adapter throws unconditionally. Both are deliberately unfinished and marked as such in the source, so auditing them against a template would produce noise rather than findings.

**Things the documents could not determine.** They stay in each document's open questions rather than becoming entries here. The largest are whether the `no_team` device-status branch is reachable at all, whether an outside collaborator's dropped co-author trailer would be noticed, and how long the silent retry window in `cogworks status` actually lasts.

**Hardening observations with no user-visible symptom.** The unauthenticated device-start route, the unbounded token poll, the two-row team creation without a transaction, the missing unique index on a cohort join code, response validation being development-only, and the 426 that escapes the error envelope. Each is real and each belongs in a security or reliability review rather than in a list ordered by what a student meets first.
