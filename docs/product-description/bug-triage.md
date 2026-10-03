# Bug triage

This file collects every defect and inconsistency the feature documents raised, in their bodies and in their "Open questions and verification" sections. Entries are deduplicated by root cause and written so the product team can decide each one without re-reading the documents. Each entry's **Status** line names the build its evidence belongs to and how it was obtained. A repair in source is not an observation of the repair.

## Sources and evidence levels

Three builds matter, and the status table has a column for each:

- **`2ff32fa`, the source and UI candidate.** What the documents describe; the State column is judged here.
- **`4984730`, the earlier hosted beta.** Pre-redesign. It shares every server, runner and contract file with `2ff32fa` except `apps/portal/worker/routes/team.ts`, one comment in `run-actions.ts`, and `python/cogbench/src/cogbench/pipeline.py`.
- **`ed2b194`, the deployed redesigned beta.** `2ff32fa` merged with `4984730`, so it has the redesign plus #46, #53 and CLI pin `b6bbffb`. It is live as Worker version `0b452503-80b8-44bc-b60d-a04a38cc5175`, the runner is unchanged at Modal v44 from `4984730`, and all eight CI lanes pass. A Deployed cell of "as candidate" means the deployed build behaves as `2ff32fa` for that entry.

A fourth commit, `cbd8266`, is a local repair branch on `ed2b194` for B-13 and B-14. It has been reviewed and tested, its B-13 recovery path was accepted locally on fixture data, and it is not deployed.

Each Status line names its evidence:

- **Code read at `2ff32fa`.** The default. It settles what the code does, not that a student has seen it.
- **Local fixture.** Screenshots, clips and the native Sol pass of the redesign on seeded data, labelled Simulated (`/tmp/cogshots/matched/pairs/`, `CogPortal-qa-video-20260930/outputs/beta-qa/`, including `final-2ff32fa/`). They prove a screen renders a state.
- **Hosted beta.** Two Recognition practice runs on `SamGu-NRX/week2_capstone@29f9cf94`: `run_f5fc5babe5` failed in Evaluate before beta's `468655c`, and its one Retry, `run_f93ba19397`, succeeded at 0.925 with persisted D1 proof. They prove that hosted path and nothing about Audio, Clustering, Language, promotion, the CLI or Discord.
- **Sol's reliability pass.** Confirmed B-13 and B-14. The same reliability work confirmed the B-55 403 loop as preexisting.
- **Deployed `ed2b194`.** The combined local acceptance (`beta-qa/ed2b194-acceptance.md`, fixture data) and one real hosted Language run, `run_d11b5e5e2e`, with a real CLI `check`, `run` and `sync` (`beta-qa/live-language-ed2b194/README.md`). That run confirmed B-68. Its 7 m 37 s Install showed progress throughout and finished; it is not evidence of a stuck run.
- **Sol audit.** A fresh read-only check of the claims behind the high entries and every "fixed in candidate" verdict. It confirmed them, and narrowed B-45, B-48 and B-68, which now say what it found.

Files under `combined-ed2b194-*` in the QA folder come from a combined build that is neither of the two above. This file does not use them.

## Summary

75 entries. In the `2ff32fa` source, 8 high, 31 medium and 19 low are open, and 17 are closed (16 fixed, one superseded). Deployed `ed2b194` also fixes B-44 and B-47, which leaves 6 high open there. B-13 and B-14 are repaired on `cbd8266` and await deployment. The 2026-09 set's worst problems, the sign-in dead end, the rewritten run history, the hash seed, the truncated Week 3 sentence and the back-button account leak, are fixed in source. Most of what remains open lives where two parts of the product meet: the runner and the run page, the setup page and the CLI it installs, the consent screen and the Discord bot. Little of it shows in the fixture screenshots, because the fixture provider scripts a tidy failure with a log, installs nothing and never runs a real search.

**Does the experience make sense?** The student path does: sign in, cohort, team, setup, run, read, promote, publish, now one decision per screen, and the run page leads with a sentence as the brief asks. Four places are more complicated than they need to be:

- **Recovering from a failed run takes two pages that disagree.** The run page says "Your code raised an exception" and sends the student to reproduce locally. Retry lives only on the console, behind a corner link, and the console calls the same failure "Submission stopped during evaluation" (`final-2ff32fa/retry-final.txt`). The hosted beta recovery that worked, `run_f5fc5babe5` to `run_f93ba19397`, needed exactly that detour, and a student following the run page's advice would have reproduced the platform's own crash locally as theirs (B-44, B-45, B-46).
- **"Used" means three things.** The Runs page counts completed attempts, the console and Discord count completed plus active, and the admin page sums every benchmark. Promotion has four confirmation styles across the Runs page, run page, console and Discord, and only one says a failure costs nothing.
- **Instructors start in the student flow.** Staff without a team are sent to join a cohort (B-48), a co-instructor added to the roster sees an empty workspace until assigned team by team (B-66), and a TA's view stops at two counts per team with nothing to open.
- **Discord asks more than it says.** Linking takes five hops with an unstated team prerequisite, the consent screen understates what `/cog` can do (B-49), the bind prompt understates what will post (B-57), and every portal error becomes "I couldn't reach Cog\*Portal just now" (B-19; the portal's own refusal reaches the bot in `f03ebfa` source).

On the two design critiques raised during review: "The scorer didn't write a finding for this run" is honest copy that exposes a benchmark gap, filed as B-68. The longer Runs page keeps its next action findable: at 390×844 "Run practice benchmark" sits about 584 CSS px down, inside the first screen (`pairs/b-dashboard-mob.png`, local fixture), though it falls below the fold on a 667 px phone. The added length is a "For reference" footer that repeats the quota and leaderboard state already shown above it. That is a trim, not a defect.

### Next repairs and evidence gaps

In order of user-visible impact on the deployed build. B-13 and B-14 (repaired on `cbd8266`; B-13's recovery path accepted locally on fixture data; not deployed) and B-68 (producer repair owned by Opus worker `0e3d690b` on benchmark pin `94c7e64`) are already in hand and are not repeated. Items 1, 2 and 5 are assigned for repair, item 3 is a separate finite repair, and item 4 is under investigation. Each describes the behavior wanted and where it lives today.

1. **Make an evaluation failure say only what the runner knows, and carry where it happened (B-45, B-46, B-11).** Today a platform crash reads "Your code raised an exception" with one line, no location and no log, and Retry is a page away, on a console that names the failure differently. This is what made B-44 cost an afternoon. `apps/runner-modal/src/cogworks_runner/modal_app.py:941`, `:1740`, `:2005-2038`, `:2318-2327`; `packages/contracts/src/failures.ts:87-96`; `apps/portal/worker/routes/runner-events.ts:247-260`; `apps/portal/src/routes/RunDetailPage.tsx:96-123`. Product call on the wording; fix for the detail.
2. **Make the Discord consent state what the link authorizes (B-49).** `apps/portal/src/routes/ConnectionsPage.tsx:84`, `:111` say Cog can't start an official evaluation; `apps/discord-bot/src/commands.ts:557-571` and `apps/portal/worker/rpc.ts:94-102` let `/cog` promote and publish. A trust-language break on a consent screen, on every build.
3. **Stop retrying a channel that answers 403 (B-55).** A finite follow-up, not a new retry framework: record the refusal and stop that surface's delivery. `apps/portal/worker/realtime/run-surface-hub.ts:163-176`; `apps/portal/worker/services/discord-messages.ts:278`, `:292-297`.
4. **One board, one measure (B-50).** A withheld Language run would be ranked by `text_mrr` among other teams' `overall`. `apps/portal/worker/services/leaderboard.ts:78`, `:108-112`. Product call. Evidence gap: the live run was fully bound, so a withheld run on `ed2b194` is still needed to observe it. Local `17d26d9` refuses publication of a run without the ranked measure; seen with a synthetic partial result ([checkpoint](verification/checkpoint-17d26d9.md)).
5. **Send staff without a team to `/admin` (B-48).** `apps/portal/src/App.tsx:34-38`, `:129-136`; `apps/portal/src/components/UserMenu.tsx:218-221`. The first thing every instructor and TA meets. Read from code; persistent instructor writes are still unobserved. Local `17d26d9` routes them to `/admin`; seen on the local fixture build ([checkpoint](verification/checkpoint-17d26d9.md)).

Remaining evidence gaps, with commands, are in [`verification/README.md`](verification/README.md#evidence-gaps): a withheld Language run, hosted Audio and Clustering, official promotion and publication, a fresh setup from the page's lines alone, the deployed lost-heartbeat repair, instructor writes, Discord and the Activity, and physical phones.

## Status table

| ID | Title | Severity | State | Hosted beta `4984730` | Deployed `ed2b194` | Area | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B-07 | Nothing lets a student leave a team, and only a team admin can let them out | high | open in `2ff32fa`; self-leave in `b0e0c55` source, seen locally on synthetic data | same | as candidate | portal | product call |
| B-08 | Uploaded weights are keyed to a commit, and nothing tells the student that | high | open | same | as candidate | terminal, sandbox | product call |
| B-11 | Week 2 never attributes a timeout, so a killed run receives the wrong failure explanation | high | open, assigned for repair | same | as candidate | sandbox | fix |
| B-13 | An interrupted `--live` run leaves the session running and the team's bubble frozen forever | high | open, repaired on `cbd8266`, not deployed | same | same; repair on `cbd8266` | terminal, discord | fix |
| B-44 | A Week 2 recognition run crashes when a describe step returns None for a faceless photo | high | fixed on deployed `ed2b194`; open in `2ff32fa` source | fixed | fixed (`468655c`) | sandbox, terminal | fix |
| B-45 | Every evaluation failure is told as "Your code raised an exception", including the platform's own | high | open, assigned for repair | same | as candidate | sandbox, portal | product call |
| B-47 | The candidate's setup page installs a CLI older than the candidate, whose link consent says scores are never sent | high | fixed on deployed `ed2b194`; open in `2ff32fa` source | fixed | fixed (pin `b6bbffb`) | portal, terminal | fix |
| B-49 | The Discord consent copy says Cog cannot start an official evaluation; `/cog` can | high | open in `2ff32fa`; Connections copy changed in `17d26d9`, seen locally | same | as candidate | portal, discord | product call |
| B-02 | Linking a device before joining a team leaves the terminal polling silently | medium | open | same | as candidate | terminal, portal | fix |
| B-04 | The "supplied" disclosure never reaches the hosted run page | medium | open | same | as candidate | sandbox, portal | product call |
| B-14 | A caller-specific GitHub failure is cached as the team's history for thirty minutes | medium | open, repaired on `cbd8266`, not deployed | differs: guards cache write | cache write guarded (`610e04a`) | portal | fix |
| B-16 | `check --update-setup` is silently ignored when the check does not pass | medium | open | same | as candidate | terminal | fix |
| B-19 | The Discord bot replaces every actionable portal error with one generic sentence | medium | open in `2ff32fa`; fixed in `f03ebfa` source, not seen in Discord | same | as candidate | discord | fix |
| B-21 | A plugin version mismatch is reported to the student as missing benchmark data | medium | open | same | as candidate | sandbox | fix |
| B-22 | The evaluation progress counter never moves | medium | open | same | as candidate | sandbox, portal, terminal | fix |
| B-25 | The Week 3 timeout message is Week 1's copy, about songs | medium | open | same | as candidate | sandbox | fix |
| B-26 | Floors print as ordinary scores in the terminal | medium | open | same | as candidate | terminal | fix |
| B-27 | A batch of live events applies partially and reports failure | medium | open | same | as candidate | portal | fix |
| B-28 | The connections page polls forever while no device is linked | medium | open | same | as candidate | portal | fix |
| B-29 | A member added from the team page or the admin console gets write access the portal never checked | medium | open | same | as candidate | portal | fix |
| B-46 | A failed hosted run carries one line: no exception class, no location, no log, none of the team's prints | medium | open, assigned for repair | same | as candidate | sandbox, portal | fix |
| B-48 | Staff without a team are routed into student onboarding and cannot reach Connections | medium | open in `2ff32fa`; routing fixed in `17d26d9`, seen locally | same | as candidate | portal | fix |
| B-50 | The leaderboard and team pages rank runs with different primary metrics together | medium | open in `2ff32fa`; publication refused in `17d26d9`, seen locally | differs: no list heading | as candidate | portal, discord | product call |
| B-51 | Team pages call a result public while the leaderboard hides it, and its attempts stay spent | medium | open | not checked | as candidate | portal | fix |
| B-52 | A board resolves `?benchmark=` to the highest version even when it is inactive | medium | open | same | as candidate | portal | fix |
| B-53 | The admin page says "No hosted runs yet" for a team whose every run failed | medium | open | same | as candidate | portal | fix |
| B-54 | A refused concurrent hosted start leaves a run-less console record that breaks `/cog` home and the Activity for the team | medium | open | same | as candidate | portal, discord | fix |
| B-55 | A channel the bot can no longer write is retried every two seconds forever | medium | open, separate finite repair | same | same; 403 loop confirmed | discord | fix |
| B-56 | The Discord leaderboard shows one arbitrary board and never marks the student's team | medium | open | same | as candidate | discord | fix |
| B-57 | The bind prompt says only shared local runs will post; every hosted run posts | medium | open | same | as candidate | discord | product call |
| B-58 | A signed-out browser loses the run a Discord or Activity link pointed at | medium | open | same | as candidate | portal, discord | fix |
| B-59 | A `run --live` report names weights it never uploads, failing the next hosted run at that commit | medium | open | same | as candidate | terminal, portal | product call |
| B-60 | A prepare killed for time or memory is reported as a dependency install failure | medium | open | same | as candidate | sandbox | fix |
| B-61 | A refusal's notes reach the browser and are never drawn | medium | open in `2ff32fa`; fixed in `f03ebfa` source, seen locally on synthetic data | same | as candidate | portal | fix |
| B-62 | The E-OUTPUT card promises checks that do not run | medium | open in `2ff32fa`; fixed in `f03ebfa` source, seen locally on fixture data | same | as candidate | sandbox, portal | fix |
| B-64 | Discord and the console put a student's login beside a score | medium | open in `2ff32fa` and `17d26d9`; removed in integrated `93dfa5e` source | same | as candidate | discord, portal | product call |
| B-65 | A team creator with only GitHub write access loses settings on first save, which can leave the team with no admin | medium | open | same | as candidate | portal | product call |
| B-66 | The staff roster promises a co-instructor "the same view"; they get an empty TA workspace | medium | open in `2ff32fa`; copy fixed in `17d26d9`, seen locally | differs: no promise copy | as candidate | portal | fix |
| B-68 | A clean Language run opens by saying the scorer wrote no finding | medium | fixed by Week 3 `9e4dcff`; seen on the `f618038` full path | differs: says it below the metrics | confirmed live, `run_d11b5e5e2e` | portal, sandbox | product call |
| B-71 | A window left visible while another signs in as someone else changes the other account's team | medium | open in `2ff32fa`; fixed through `9f94f38` source, rechecked in two headless windows; not deployed | same | as candidate | portal | fix |
| B-03 | Two gates disagree about which team members Discord serves | low | latent | same | as candidate | discord | fix |
| B-09b | Hosted practice confirmations say every run uses quota; only completed runs do | low | narrowed | same | as candidate | discord, portal | fix |
| B-12 | `/cog view:connect` for an already-linked student is a dead end | low | open | same | as candidate | discord | fix |
| B-15 | Re-linking a device accumulates live tokens that nothing revokes | low | narrowed | same | as candidate | terminal, portal | fix |
| B-17 | The longest paragraphs in `cogworks check` are not wrapped | low | narrowed | same | as candidate | terminal | fix |
| B-18 | The most ordinary failure verdict has no next step | low | open | same | as candidate | terminal | product call |
| B-30 | Churn events record one author while the rest of the process panel credits co-authors | low | narrowed | same | as candidate | portal | fix |
| B-31 | Unreleased benchmarks' titles and summaries are public | low | narrowed | same | as candidate | portal | product call |
| B-32 | The device has two different names | low | open | same | as candidate | terminal, portal | fix |
| B-33 | `--json` output is followed by a plain-text line | low | open | same | as candidate | terminal | fix |
| B-34 | A malformed response or file gives a traceback instead of a sentence | low | open | same | as candidate | terminal | fix |
| B-35 | The official-attempt limit is still hardcoded in the Discord bot | low | narrowed | differs: console also hardcodes | as candidate | discord | fix |
| B-37 | `cancelled` is a status nothing can ever produce | low | open | same | as candidate | portal | product call |
| B-38 | Four dead code paths and one tautological test | low | open | same | as candidate | discord, portal | fix |
| B-41 | Small copy and consistency slips | low | narrowed | differs: two bullets open | as candidate | portal, discord | fix |
| B-63 | The setup page calls a CLI report from the student's machine "Verified" | low | open | same | as candidate | portal | product call |
| B-67 | An official attempt does not say which synced weights it scored with | low | promotion copies the line; Retry repaired in integrated `93dfa5e` source; not observed | same | as candidate | sandbox, portal | fix |
| B-69 | Small behavior slips in the redesign | low | open | not checked | as candidate | portal, discord, sandbox, terminal | fix |
| B-70 | Small copy slips in the redesign | low | open | not checked | as candidate | portal, terminal | fix |
| B-00 | A successful GitHub sign-in leaves the student on the marketing page | n/a | fixed in candidate | fixed | as candidate | portal | none |
| B-00a | A partial GitHub outage silently shortens the repository list | n/a | fixed in candidate | fixed | as candidate | portal | none |
| B-01 | Week 1 scores student code under a randomized hash seed, and the guard test cannot see it | n/a | fixed in candidate | fixed | as candidate | sandbox | none |
| B-05 | `cogworks run --live` checks its preconditions after the ninety-second search | n/a | fixed in candidate | fixed | as candidate | terminal | none |
| B-06 | Changing the repository rewrites what every earlier run page claims | n/a | fixed in candidate | fixed | as candidate | portal | none |
| B-09 | The weight upload has a fifteen-second timeout and a two-hundred-megabyte ceiling | n/a | fixed in candidate | fixed | as candidate | terminal | none |
| B-09a | The Week 3 withheld sentence is cut off mid-word before the student reads it | n/a | fixed in candidate | fixed | as candidate | sandbox | none |
| B-09c | The admin console counts quota differently from the quota | n/a | fixed in candidate | fixed | as candidate | portal | none |
| B-10 | `cogworks check` can exit 0 on a repository `cogworks run` refuses | n/a | fixed in candidate | fixed | as candidate | terminal | none |
| B-20 | The live run surface is unreachable from the portal and has no way out | n/a | fixed in candidate | differs: header nav only | as candidate | portal | none |
| B-23 | Promote is clickable while the quota is still loading | n/a | fixed in candidate | fixed | as candidate | portal | none |
| B-36 | Four user-facing strings use em dashes, which the voice guide bans | n/a | fixed in candidate | differs: console em dash | as candidate | portal, discord | none |
| B-39 | Revoking a device and unlinking Discord have no confirmation | n/a | fixed in candidate | differs: one-press revoke | as candidate | portal | none |
| B-40 | The rail marks every stage done as soon as a result is published | n/a | fixed in candidate | fixed | as candidate | discord | none |
| B-42 | A run with no overall score shows none of the evidence it does have | n/a | fixed in candidate | fixed | as candidate | portal | none |
| B-43 | The back button restores a previous account's page | n/a | fixed in candidate | fixed | as candidate | portal | none |
| B-24 | The refund cap is bypassed when Modal dispatch fails | n/a | superseded | same | as candidate | portal | none |

## High

### B-07: Nothing lets a student leave a team, and only a team admin can let them out

- **Where the user meets it:** A student joins the wrong team, or is added to one by mistake, and finds no way out. A staff member without a team who follows the onboarding path (B-48) walks into the same door.
- **What happens / what was expected:** No control or route on any surface removes a member from their own team. Removal is admin-only and refuses an admin, so a stored admin can be removed by nobody, and the admin console now hides Remove on admin rows. The unique index on `team_members.userId` allows one team at a time. The worker still says "Leave it before joining a different cohort.", but `/join` now redirects anyone with a cohort, so the interface never shows it. Expected: a way out, with its consequence stated.
- **Reproduce:** Join a team, then look for any way to leave it in the portal, the CLI, or Discord.
- **Why (from the code):** `apps/portal/worker/db/schema.ts:196` (the unique index); `apps/portal/worker/routes/team-membership.ts:282-318` ("A team admin can't be removed." at `:304`); `apps/portal/worker/routes/admin.ts:442-447`; `apps/portal/src/routes/AdminPage.tsx:527-530`; `apps/portal/worker/routes/cohorts.ts:38`; `apps/portal/src/routes/JoinPage.tsx:21-23`.
- **Severity:** `high`. A one-way door that needs an instructor to open, on a platform whose users are seventeen and will make this mistake.
- **Decision needed:** `product call`. Add a leave control with a stated consequence and a rule for the team's history, or keep the door shut and delete the unreachable cohort sentence.
- **Raised by:** [`portal/the-team-page.md`](portal/the-team-page.md#open-questions-and-verification), [`foundations/the-team-and-the-repository.md`](foundations/the-team-and-the-repository.md#open-questions-and-verification), [`portal/join-or-make-a-team.md`](portal/join-or-make-a-team.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Retitled from "only the creator" because removal checks the stored admin role, not who created the team. Same on beta.
- **Status, `b0e0c55` (2026-10-03):** decided as self-leave and built; not deployed. Any member, the last admin and the last member included, can take themselves off their team with Leave on their own People row (`apps/portal/src/routes/TeamPage.tsx:443`). `POST /api/team/leave` deletes only the caller's membership on the team the page showed (`apps/portal/worker/routes/team-membership.ts:215-234`); the team keeps its repository, runs, attempts, publications, TAs and Discord channel, and GitHub is not touched, so a collaborator can join again and gets GitHub's current role. A retry answers "You'd already left"; a stale tab after moving to another team is refused with "You're on {team} now, not the team this page showed. Reload to see it." and removes nothing. Afterwards the device credential cannot write into the old team: a live run's next event is refused with "You're no longer on this run's team, so the portal stopped recording it. The run still finishes here and saves its report on this machine." (`local-runs.ts:110`), and a report linked to that run is frozen and kept out of a later team's list and weights (`local-reports.ts:43`, `:251`). Removing another admin is still refused, and staff removal is unchanged. Evidence: `apps/portal/test/team-leave.test.ts` (19) and `team-leave-render.test.ts` (4), and headless Chromium on the local dev server with synthetic users (`~/.long-run/cogportal/evidence/student-recovery/postaudit-leave-desktop.json`, `postaudit-leave-cases.json`, `screens/leave-*.png`). Not verified: real GitHub accounts, a deployed build.
- **Status, `1eb371c` (2026-10-03):** the rejoin described above holds for live teams only. For a past-course (`archive`) team, students can't join an archive team themselves (`apps/portal/worker/routes/team-membership.ts:143-150`), while staff can add a member to any team in their scope (`apps/portal/worker/routes/admin.ts:389-393`), so the armed Leave line and the notice after leaving say only course staff can add the student back instead of offering to join again. Leaving stays allowed. Evidence: `apps/portal/test/team-leave-render.test.ts` (archive last member, archive leave and notice).
- **Status, `1509481` (2026-10-03):** When a leave's outcome is unknown (the connection dropped, the server failed, or the answer could not be read), the row shows "We couldn't confirm whether you left. Reload to see where you stand." with Reload page, and Leave is gone until a full reload. A second press could otherwise delete a membership made since, elsewhere: a membership row holds only team and student, so the same team joined again cannot be told from the one the lost request deleted. A refusal the server gave keeps Leave, since it removed nothing (`apps/portal/src/lib/queries.ts`, `useLeaveUnconfirmed`). The server's guarantee is narrower than the `b0e0c55` line above suggests: a repeat while the student is still off that team removes nothing and answers "You'd already left", and a stale tab after joining another team gets a 409, but after joining the same team again a repeat removes the new membership (`apps/portal/worker/routes/team-membership.ts`, POST /team/leave). Evidence: `apps/portal/test/team-leave-render.test.ts` (lost answer, rejoin elsewhere, no second request; reload can leave; a 409 keeps Leave).
- **Status, `d967b1c` (2026-10-03):** two more team writes now check membership when they run, not only before the request's own awaits. Publishing a result re-checks that the publisher is still on the team inside the leaderboard selection write, so leaving while GitHub's permission check or the provider sync is pending publishes nothing and replaces no existing selection; the student reads "You're no longer on this team, so nothing was published. Reload to see where you are." Any current member may still publish (`apps/portal/worker/services/run-actions.ts`, `publishOfficialRun`). Choosing the Discord channel re-checks a current admin or maintain role inside the UPDATE, so leaving or losing the role while Discord checks the channel leaves the old team's channel as it was (`apps/portal/worker/services/discord.ts`, `bindDiscordTeamChannel`). Evidence: `apps/portal/test/run-actions.test.ts` (leave before a new or a replaced selection, demotion still publishes) and `rpc-refusals.test.ts` (admin and maintainer bind; leave or demotion while Discord answers). Not verified against a deployed build or real Discord.

### B-08: Uploaded weights are keyed to a commit, and nothing tells the student that

- **Where the user meets it:** A Week 3 team follows the platform's own advice, syncs their weights, pushes one more commit, starts a hosted run, and gets a withheld overall again with no explanation.
- **What happens / what was expected:** A hosted run fetches only weights recorded by a local report at its own commit. Storage keys are now content-addressed (`weight-objects/{repo}/{sha}/{sha256}/{path}`), digest-checked in prepare, capped at 100 MiB and filtered by benchmark, and still bound to the commit. When weights are supplied the run page says "{paths} from your local run at {shortSha}"; when a push un-supplies them, nothing is said, and the Week 3 diagnostic that sends teams down this path names no commit. Expected: either the student is told, or the pairing survives a commit that did not touch the weights.
- **Reproduce:** Run locally, sync, commit anything, push, start a hosted run, and compare the metrics with a hosted run at the synced commit.
- **Why (from the code):** `apps/portal/worker/services/weights.ts:125-132`; `apps/portal/worker/services/local-reports.ts:319-345` (filters on the sha at `:340`); `apps/portal/worker/execution/runner.ts:345-352`; `apps/portal/src/routes/RunDetailPage.tsx:177-180`; the advice is `benchmarks/week3/language_search_benchmark/roles.py:917-932` at the pinned `94c7e64f`.
- **Severity:** `high`. The failure is silent, it looks identical to never having synced, and it lands on the one week that depends on this path.
- **Decision needed:** `product call`. Saying so in the diagnostic is one sentence. Making the pairing survive a commit means keying on something other than the revision, which weakens the guarantee that the weights match the code that produced them.
- **Raised by:** [`terminal/sync.md`](terminal/sync.md#open-questions-and-verification), [`sandbox/prepare.md`](sandbox/prepare.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa` by two clusters. Same on beta.

### B-11: Week 2 never attributes a timeout, so a killed run receives the wrong failure explanation

- **Where the user meets it:** A Week 2 team's run is killed at the fifteen-minute ceiling. They are shown a generic evaluation failure. The failure uses no quota.
- **What happens / what was expected:** `_evaluate_v2` records no start time and never calls `_timed_out`, so both vision benchmarks report a kill at 900 s as E-RUNTIME "Your code raised an exception" (B-45). The Week 1 and Week 3 lanes attribute the limit and give the timeout advice. Expected: the same attribution in every lane.
- **Reproduce:** Submit a Week 2 repository whose evaluation exceeds 900 seconds and read the failure card.
- **Why (from the code):** `apps/runner-modal/src/cogworks_runner/modal_app.py:1728-1740` against `:1796`/`:1815` and `:1878`/`:1896`; both vision benchmarks route to `_evaluate_v2` at `:2237` and `:2254`. `apps/runner-modal/tests/test_limit_attribution.py` covers only the exception classifier, which is why it passes.
- **Severity:** `high`. The student is told their code raised when it ran out of time, and is denied the one message that says what to change.
- **Decision needed:** `fix`.
- **Raised by:** [`sandbox/timeouts-and-limits.md`](sandbox/timeouts-and-limits.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta. The release owner has assigned the repair; nothing has changed in source yet.

### B-13: An interrupted `--live` run leaves the session running and the team's bubble frozen forever

- **Where the user meets it:** A student kills a `cogworks run --live`, closes the terminal, or their laptop sleeps. The bubble in the team channel stays on a live loader indefinitely.
- **What happens / what was expected:** Ctrl+C, uncaught exceptions and failures during the search now send a failed event, because the session opens before the search. `kill -9` and a closed window send nothing, and nothing sweeps `local_run_sessions`. A second route: a commit made during a live run makes the portal refuse the completed event as a mismatch, and the CLI never sends another terminal event, so that session also stays running. While a session stays running, the hub re-edits its frozen bubble every 2 s indefinitely, on the bot token all teams share. Expected: an abandoned local session ages out the way a stale hosted run does.
- **Reproduce:** Start `cogworks run --benchmark <id> --live` and close the terminal window. For the second route, commit while the run is going.
- **Why (from the code):** `apps/portal/worker/execution/maintenance.ts:43-61` selects only from `runs`; `apps/portal/worker/routes/local-runs.ts:139-148` (only an event moves a session off running) and `:108-115` (the mismatch refusal); `python/cogbench/src/cogbench/cli.py:966-968`, `:1356-1368`; `apps/portal/worker/realtime/run-surface-hub.ts:178`.
- **Severity:** `high`. It is visible to the whole team, permanent, the student who caused it cannot clear it, and each one is an endless edit loop on a shared token.
- **Decision needed:** `fix`. Age out a local session with no event for some multiple of the two-second heartbeat.
- **Raised by:** [`terminal/run.md`](terminal/run.md#open-questions-and-verification), [`discord/channel-messages.md`](discord/channel-messages.md#open-questions-and-verification), [`cross-cutting/live-updates.md`](cross-cutting/live-updates.md#open-questions-and-verification)
- **Status:** open, repair active elsewhere. Confirmed by Sol's reliability pass (local live runs stay `running` after the CLI heartbeat stops). Source repair on `cbd8266` (`683d7ea`, `3a08b61`, `25d4bdc`, `cbd8266`, on top of deployed `ed2b194`): a silent live run is shown as lost contact on the web console and in `/cog`, and a late result is still delivered if its first publication fails. Reviewed and tested, website consumer included; not deployed, and native local runtime QA and the cache/liveness PR publication are in progress. Do not start a second implementation. Byte-identical on beta. Local acceptance on `cbd8266` passed with limits (`beta-qa/cbd8266-recovery-acceptance.md`). One disposable session, `localrun_48f82c0a6d27ed4330d1dcf5c8396a99`, was driven through the real local start and event endpoints. It showed "Lost contact · evaluating" with no progress bar and `aria-busy=false`. A real heartbeat restored live progress without a refresh, and a late completed report turned the console to "Bench clear", which a refresh kept. The "Run again" dialog handed focus back correctly, and nothing overflowed at 390 and 768 px. Limits: the result was a declared fixture, not student code. Lost contact was reached by aging timestamps and refreshing, not by a natural two-minute silence. No Discord bubble, Activity or hosted run was involved. Dark Reader recolored the stills, so they show state and layout, not palette. Still not deployed.

### B-44: A Week 2 recognition run crashes when a describe step returns None for a faceless photo

- **Where the user meets it:** A Week 2 Recognition team's hosted practice run, or `cogworks run --benchmark vision-recognition` locally, when the team's describe step returns `None` for a photo with no face.
- **What happens / what was expected:** The search binds the describe step on fixture photos that all have faces. Replaying it, cogbench's own pipeline reads element k of every per-item answer and raises "'NoneType' object is not subscriptable" on the first faceless photo. Hosted, the run fails E-RUNTIME at Evaluate and is told as the team's fault (B-45). Locally, the CLI prints NO RESULT with "ContractError: Student adapter execution failed: 'NoneType' object is not subscriptable". Expected: `None` reaches the benchmark, which reads it as no face.
- **Reproduce:** Hosted practice run of `SamGu-NRX/week2_capstone@29f9cf94` on vision-recognition v2.
- **Why (from the code):** `python/cogbench/src/cogbench/pipeline.py:834` (`row[candidate.element]` for every row); the local wrap is `python/cogbench/src/cogbench/runner.py:236-237`. Beta `468655c` passes `None` through (beta `pipeline.py:834-841`).
- **Severity:** `high`. A correct Week 2 submission fails every hosted run that meets a faceless photo, and the team is blamed for it.
- **Decision needed:** `fix`. Port `468655c` and its tests.
- **Raised by:** [`portal/the-run-page.md`](portal/the-run-page.md#open-questions-and-verification), [`foundations/the-run.md`](foundations/the-run.md#open-questions-and-verification), [`terminal/run.md`](terminal/run.md#open-questions-and-verification), [`sandbox/discovery.md`](sandbox/discovery.md#open-questions-and-verification), [`foundations/what-the-portal-claims.md`](foundations/what-the-portal-claims.md#open-questions-and-verification), [`sandbox/scoring-and-refusals.md`](sandbox/scoring-and-refusals.md#open-questions-and-verification)
- **Status:** fixed on deployed `ed2b194`; open in the `2ff32fa` source. Hosted beta run `run_f5fc5babe5` failed (`hosted-run_f5fc5babe5/result.json`, `failed-dom.txt`); its Retry `run_f93ba19397`, after beta `468655c`, succeeded at 0.925 with the D1 row persisted (lead's record). That success proves only the hosted Recognition practice path. The local CLI path is read from code. Still present in the `2ff32fa` source; fixed on deployed `ed2b194`, which merges `468655c`.

### B-45: Every evaluation failure is told as "Your code raised an exception", including the platform's own

- **Where the user meets it:** The run page after any hosted failure in Evaluate.
- **What happens / what was expected:** Once the evaluate script has imported team code, an exception becomes `student_runtime`, titled "Your code raised an exception", with local reproduction as the next step. Weeks 1 and 3 test for a timeout first; the Week 2 lane does not, so a killed vision run is also told this way (B-11). The platform's second search and pipeline replay run inside the region marked as student-owned, so B-44 was told as the team's fault. The runner cannot tell whose frame raised, because student code can forge frames, so this is a decision about wording and ownership; prepare already uses neutral wording ("This run did not reach scoring"). Two related slips: the console says "Submission stopped during evaluation" for the failure the run page titles "Your code raised an exception" (`07-contact.png` at `8052b12`; `final-2ff32fa/retry-final.txt` at `2ff32fa`, local fixture), and Retry, "Runs the same commit again.", is offered for every failed execution although `failures.ts` marks E-RUNTIME, E-CONTRACT and others `retryable: false`.
- **Reproduce:** B-44 on `2ff32fa`, or beta run `run_f5fc5babe5`.
- **Why (from the code):** `apps/runner-modal/src/cogworks_runner/modal_app.py:941`, `:972`, `:993`, `:1008` set the owner to the student before loading; `_discovered_factory` (`:847-894`) runs inside that region; the mapping is at `:1670`, `:1740`, `:1826`, `:1907`. Copy at `packages/contracts/src/failures.ts:87-96`, card at `apps/portal/src/components/FailureCard.tsx:65-124`. The neutral contrast is `apps/runner-modal/tests/test_prepare_attribution.py:165-183`. `retryRun` in `apps/portal/worker/services/run-actions.ts` has no retryable check.
- **Severity:** `high`. It assigns a fault the platform cannot observe, on the most common hosted failure.
- **Decision needed:** `product call`. Choose the claim the copy makes (for example "The evaluation raised an exception" plus where), and whether Retry stays offered for categories the catalog calls non-retryable.
- **Raised by:** [`portal/the-run-page.md`](portal/the-run-page.md#open-questions-and-verification), [`sandbox/discovery.md`](sandbox/discovery.md#open-questions-and-verification), [`sandbox/timeouts-and-limits.md`](sandbox/timeouts-and-limits.md#open-questions-and-verification), [`foundations/the-run.md`](foundations/the-run.md#open-questions-and-verification), [`foundations/what-the-portal-claims.md`](foundations/what-the-portal-claims.md#open-questions-and-verification), [`sandbox/scoring-and-refusals.md`](sandbox/scoring-and-refusals.md#open-questions-and-verification)
- **Status:** open. Observed on hosted beta (`hosted-run_f5fc5babe5/failed-dom.txt`, E-RUNTIME · Evaluate); the runner and contracts are byte-identical at `2ff32fa`. Same on beta. The release owner has assigned the repair; nothing has changed in source yet.

### B-47: The candidate's setup page installs a CLI older than the candidate, whose link consent says scores are never sent

- **Where the user meets it:** Setup step 2, "Install the CogWorks tool", then `cogworks link`.
- **What happens / what was expected:** The candidate pins the CLI at `40d31a2`, seven `python/cogbench/src` commits behind `2ff32fa`. That CLI's link consent says it sends "never source, paths, logs, predictions, scores, or environment variables", yet `sync` and `run --live` send scores. Its reports carry no command, so they print plain LOCAL and `test` results are not marked as smoke. Check names `submission.py` when `benchmark_adapter.py` resolved. It also lacks two private-copy discovery fixes, so a module that writes a cache at import can come back not_read. Expected: the pin moves with the candidate. Neither build serves TestPyPI 0.1.0.
- **Reproduce:** Run the candidate Setup's install line in a fresh environment, then `cogworks link --portal <origin> --no-browser`.
- **Why (from the code):** `apps/portal/src/lib/benchmark-packages.ts:40-41`; `git log --no-merges 40d31a2..2ff32fa -- python/cogbench/src` lists seven commits, including `b30a93e`, `ff54625`, `2aa05a8`, `deb8ef3`, `a08b58f`.
- **Severity:** `high`. The first consent every student reads is false about scores, and the installed discovery is older than the one scoring them.
- **Decision needed:** `fix`. Move the pin to a commit in the candidate's own history.
- **Raised by:** [`terminal/link.md`](terminal/link.md#open-questions-and-verification), [`terminal/check.md`](terminal/check.md#open-questions-and-verification), [`terminal/run.md`](terminal/run.md#open-questions-and-verification), [`terminal/report.md`](terminal/report.md#open-questions-and-verification), [`terminal/sync.md`](terminal/sync.md#open-questions-and-verification)
- **Status:** open. The pin is visible in the local fixture `pairs/a-setup-desk.png`; the consent text is read from code at `40d31a2`. Beta moved its own pin (`cc9cd3f`, then `4984730` to `b6bbffb`). Fixed on deployed `ed2b194`: Setup shows pin `b6bbffb` (`beta-qa/ed2b194-acceptance.md`), and the live Language CLI pass used source equal to it.

### B-49: The Discord consent copy says Cog cannot start an official evaluation; `/cog` can

- **Where the user meets it:** The Connections page, while confirming a Discord link.
- **What happens / what was expected:** The panel reads "Cog receives neither source code nor your GitHub token, and it can't start an official evaluation.", and the lede says neither Discord nor the CLI "can submit an official result". Once linked, `/cog` and the Activity offer "Promote to official", which spends an attempt, and "Publish to leaderboard", and the portal performs both. Expected: consent copy states what the link authorizes.
- **Reproduce:** Link Discord, read the panel, then promote a run from `/cog`.
- **Why (from the code):** `apps/portal/src/routes/ConnectionsPage.tsx:84`, `:111` against `apps/discord-bot/src/commands.ts:557-571` and `apps/portal/worker/rpc.ts:94-102`.
- **Severity:** `high`. A consent screen that understates what it grants breaks the trust rule at the moment it matters most.
- **Decision needed:** `product call`. Say that Discord can promote and publish, or remove those actions from Discord.
- **Raised by:** [`discord/commands.md`](discord/commands.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta (beta `ConnectionsPage.tsx:71`, `:95`). The release owner has assigned the repair; nothing has changed in source yet.
- **Status, local `17d26d9` (2026-10-02):** the Connections copy now states the grant (`ConnectionsPage.tsx:113`, `:251` at `17d26d9`). On the local fixture build the page read "Cog can start and retry hosted runs, spend official attempts and publish to the public leaderboard as you." Not observed: the Discord link confirmation panel, and `/cog` promoting or publishing ([checkpoint](verification/checkpoint-17d26d9.md)).

## Medium

### B-02: Linking a device before joining a team leaves the terminal polling silently

- **Where the user meets it:** A student who finds the CLI before finishing the browser flow runs `cogworks link`, opens the URL, and is bounced to `/join` or `/connect`. The terminal keeps waiting.
- **What happens / what was expected:** Approval requires a team, so the stage gate redirects the browser. The code survives, and `/join` and `/connect` show "Your device link is on hold". That notice tells the student to run `cogworks link --portal ...` again, which starts a second code while the first terminal keeps polling; reopening the original URL is the recovery that works. The terminal hears nothing for up to ten minutes. Expected: the terminal learns the browser went elsewhere, and the notice points back at the original URL.
- **Reproduce:** Sign in with a fresh account, do not join a team, run `cogworks link --portal <origin>`, open the URL, and watch both halves.
- **Why (from the code):** `apps/portal/worker/routes/connections.ts:171` (approve requires a team); `python/cogbench/src/cogbench/client.py:80-90` (no dropped state); `apps/portal/src/components/DroppedLinkNotice.tsx:27-31`; `apps/portal/src/lib/pending-return.ts:31-40`.
- **Severity:** `medium`, down from high. Ten silent minutes, recoverable by reopening the original URL.
- **Decision needed:** `fix`. A distinguishable poll response for a code waiting on a team, and a notice that sends the student back to the original URL.
- **Raised by:** [`terminal/link.md`](terminal/link.md#open-questions-and-verification), [`foundations/identity-and-roles.md`](foundations/identity-and-roles.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Retitled after the device pass at `49f6a98` showed the code is not destroyed: a fresh account joined a team, reopened the original URL, and the waiting CLI completed. Terminal half same on beta.

### B-04: The "supplied" disclosure never reaches the hosted run page

- **Where the user meets it:** A student reads a hosted run page and cannot tell whether their score used resources the benchmark handed their code, such as GloVe vectors or an id-to-name table over the enrolled songs.
- **What happens / what was expected:** Discovery still builds the supplied rows, and they reach only `cogworks check --json`. Neither sandbox reader carries them and the wire contract has no field. The comment that promised a run page would show them was rewritten in `da36ac8`, so the code no longer contradicts itself, and the gap remains. The only "supplied" line on a hosted run page is the synced-weights line, which is the team's own file.
- **Reproduce:** Run `cogworks check` on a Week 3 repository and read the supplied lines, then start a hosted run on the same commit and compare the run page.
- **Why (from the code):** `python/cogbench/src/cogbench/resolve.py:628-633`; `python/cogbench/src/cogbench/cli.py:786`, `:795`; `apps/runner-modal/src/cogworks_runner/modal_app.py:1042-1099` (`_refusal_from`) and `:1609-1642` (`_collect_wiring`); `packages/contracts/src/protocol.ts:158-189`; `apps/portal/src/routes/RunDetailPage.tsx:177-181`.
- **Severity:** `medium`, down from high now the false claim is gone. Hosted numbers reach the leaderboard, and a score made with a supplied resource is a different claim.
- **Decision needed:** `product call`. Add the field and render it, or decide hosted pages do not disclose and say so in the code.
- **Raised by:** [`cross-cutting/what-the-benchmark-supplied.md`](cross-cutting/what-the-benchmark-supplied.md#open-questions-and-verification), [`sandbox/discovery.md`](sandbox/discovery.md#open-questions-and-verification), [`foundations/what-the-portal-claims.md`](foundations/what-the-portal-claims.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-14: A caller-specific GitHub failure is cached as the team's history for thirty minutes

- **Where the user meets it:** A team opens the team page and is told their history could not be read, for half an hour, because one teammate's request failed first.
- **What happens / what was expected:** Only GitHub history is cached now; runs are re-read on every request, and a GitHub 401 is never stored. Still stored team-wide for thirty minutes: a caller with no token stores `fetch_failed`, and a `not_found` or `rate_limited` answer under one caller's token is stored the same way. The footer "History checked {time ago}" is the only hint. Expected: a failure tied to one caller is not cached as a fact about the team.
- **Reproduce:** Have a member with no stored GitHub token open `/team`, then have another member open it within thirty minutes.
- **Why (from the code):** `apps/portal/worker/routes/team.ts:284-296` (no token stores `fetch_failed`; 401 skipped at `:292-296`) and `:258-274` (served to the team for thirty minutes); the 401 test is `process-signals.test.ts:656`; narrowed in `83d7e14`.
- **Severity:** `medium`, down from high, because the common expired-token case is no longer stored.
- **Decision needed:** `fix`.
- **Raised by:** [`portal/the-team-page.md`](portal/the-team-page.md#open-questions-and-verification)
- **Status:** open, repair active elsewhere. Confirmed by Sol's reliability pass (caller-token lookup failure poisoning shared history). Source repair on `cbd8266` (`45fd963`, `1b00e6d`): a failure that belongs to one caller is no longer stored as the team's history, and only history GitHub actually returned is stored. Reviewed and tested; not deployed. Beta differs: on the candidate a failed insert into `team_process_signals` throws out of `GET /api/v1/team/process` and the whole panel shows its error card (`team.ts:306-314`); beta `610e04a` (#46) catches it and still returns the fetched history (beta `team.ts:307-318`), and that test was not carried to the candidate.

### B-16: `check --update-setup` is silently ignored when the check does not pass

- **Where the user meets it:** A student copies the exact command from the setup page, the check reports a problem, and the setup guide never advances.
- **What happens / what was expected:** The update is gated on the check exiting 0, with no else branch. Setup step 5 now says "If the box doesn't tick, the reason is in your terminal.", but the terminal says nothing about the dropped flag. The pinned CLI `40d31a2` has the same gate. Expected: the flag reports that it did nothing, or the steps that passed are recorded.
- **Why (from the code):** `python/cogbench/src/cogbench/cli.py:1166-1172`; `apps/portal/src/lib/setup-progress.ts:165` (the setup command carries the flag); `apps/portal/src/routes/SetupPage.tsx:255`.
- **Severity:** `medium`. Confusing at the moment a student is already stuck, but recoverable.
- **Decision needed:** `fix`. One sentence on stderr would be enough.
- **Raised by:** [`terminal/check.md`](terminal/check.md#open-questions-and-verification), [`portal/setup.md`](portal/setup.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-19: The Discord bot replaces every actionable portal error with one generic sentence

- **Where the user meets it:** Anything that goes wrong in Discord reads as "I couldn't reach Cog\*Portal just now. Nothing changed. Try again in a moment."
- **What happens / what was expected:** The bot's error handler collapses every thrown error. The lost sentences include the bot-permissions instruction, "That channel already belongs to {name}.", "The official-attempt quota is exhausted.", and now the GitHub checks every Discord mutation makes: "Sign in to GitHub on Cog\*Portal before changing a run." and "GitHub access expired. Sign in to Cog\*Portal again." The Activity shows the same errors verbatim. Expected: an error the portal wrote for a reader reaches the reader.
- **Why (from the code):** `apps/discord-bot/src/index.ts:38-47`, `:129-139`; sources at `apps/portal/worker/services/run-actions.ts:125`, `:135`, `:258`, `:421`, `:712` and `apps/portal/worker/services/discord.ts:124`, `:218`, `:225`; the Activity at `apps/portal/src/activity-main.tsx:54-62`.
- **Severity:** `medium`. It hides every actionable refusal and makes the bot untriageable from a student report.
- **Decision needed:** `fix`. Pass through the portal's message for known error codes and keep the generic sentence for transport failures.
- **Raised by:** [`discord/commands.md`](discord/commands.md#open-questions-and-verification), [`cross-cutting/refusals-and-disclosure.md`](cross-cutting/refusals-and-disclosure.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.
- **Status, `f03ebfa` (2026-10-03):** fixed in source; not seen in a Discord client. Both catches in the bot now call `failureResponse` (`apps/discord-bot/src/index.ts:47`, `:138`; `apps/discord-bot/src/failure.ts:25-48`). The portal's RPC entrypoint wraps every method in `answer`, which lets an `ApiHttpError` through and replaces anything else with "Cog\*Portal could not complete that request." after logging it (`apps/portal/worker/rpc.ts:35-48`, deciding through `publicApiError`, `apps/portal/worker/http/errors.ts:43-47`). The bot treats an error as a refusal only when it arrives named `ApiHttpError` with a known code and a message of at most 600 characters (`portalRefusal`, `packages/contracts/src/discord.ts:52-67`); it shows that message with Markdown escaped (`plainText`, `packages/discord-kit/src/format.ts:66-73`) and mentions off (`apps/discord-bot/src/interaction.ts:77`), with "Back to Cog" and an "Open Cog\*Portal" link to the run or the Runs page. Any other failure on a `:confirm` button reads "I couldn't confirm that with Cog\*Portal. It may still have gone through, so check the run there before pressing it again.", or "...check the team bench before trying again." for the channel bind; on a read it reads "I couldn't reach Cog\*Portal just now. Try again in a moment." The bot no longer says "Nothing changed". The channel-bind refusals became `ApiHttpError`s (`apps/portal/worker/services/discord.ts:83-135`, `:210-233`), and the conflict now reads "That channel already belongs to {name}. Open /cog in your own team's channel and choose it there." The "GitHub access expired" sentence is gone (B-19 quoted it); the write-access check now tells an expired sign-in, lost access and a GitHub failure apart ([`foundations/the-run.md`](foundations/the-run.md#asking)). Evidence: `apps/discord-bot/test/refusal-handoff.test.ts` (8 tests) and `apps/portal/test/rpc-refusals.test.ts`, both passing, and a miniflare 4.20260708.1 probe at compatibility date 2026-07-01 in which an `ApiHttpError` crossed a service binding with its name, code and status and a plain `Error` arrived with none (`~/.long-run/cogportal/evidence/student-recovery/rpc-probe/result.json`). Not verified: a real Discord client, the deployed bindings.

### B-21: A plugin version mismatch is reported to the student as missing benchmark data

- **Where the user meets it:** A run fails with "Benchmark data is not ready" when the deployed plugin and the run job disagree about a version.
- **What happens / what was expected:** The contract check raises the mismatch as `data_download`, so the run page says E-DATA "Benchmark data is not ready", the live console says "The hosted runner could not finish", and Discord says "Runner unavailable": three accounts of one failure. `data_download` is also the category when the team's own synced weight cannot be fetched, where the copy about a reviewed checksum describes a student file (B-69). Expected: `contract_invalid` or `provider`.
- **Why (from the code):** `apps/runner-modal/src/cogworks_runner/modal_app.py:1273-1280`, `:1575`; `packages/contracts/src/failures.ts:41-49`; `apps/portal/worker/services/run-surfaces.ts:72`; `apps/portal/src/components/RunConsole.tsx:52`; `apps/portal/worker/services/discord-messages.ts:96`.
- **Severity:** `medium`. No quota is lost, only the student's and instructor's time chasing the wrong thing.
- **Decision needed:** `fix`.
- **Raised by:** [`sandbox/scoring-and-refusals.md`](sandbox/scoring-and-refusals.md#open-questions-and-verification), [`foundations/the-run.md`](foundations/the-run.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-22: The evaluation progress counter never moves

- **Where the user meets it:** Watching a run, the student sees "0 of N cases" for the whole of the longest phase, then N of N.
- **What happens / what was expected:** The sandbox reports zero at the start, the heartbeat repeats zero, and the only other value is the terminal one. The CLI's local run does the same. Only the console shows counts; the run page shows none. Expected: real progress, or no counter, since a bar that does not move reads as a hang.
- **Why (from the code):** `apps/runner-modal/src/cogworks_runner/modal_app.py:2246-2258`; `python/cogbench/src/cogbench/runner.py:231`, `:245`; `python/cogbench/src/cogbench/cli.py:835`; rendered at `apps/portal/src/components/RunConsole.tsx:390-407`.
- **Severity:** `medium`. It is the phase most likely to make a student think the platform has stopped.
- **Decision needed:** `fix`.
- **Raised by:** [`portal/watching-a-run.md`](portal/watching-a-run.md#open-questions-and-verification), [`cross-cutting/live-updates.md`](cross-cutting/live-updates.md#open-questions-and-verification), [`terminal/run.md`](terminal/run.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-25: The Week 3 timeout message is Week 1's copy, about songs

- **Where the user meets it:** A `language-search` team times out and reads advice about enrolling every song.
- **What happens / what was expected:** The two messages are byte-identical. In the redesign the wrong sentence is the open detail and the correct Week 3 advice is the Next step directly beneath it. Expected: Week 3's message describes Week 3's work.
- **Why (from the code):** `apps/runner-modal/src/cogworks_runner/modal_app.py:1816-1825` against `:1897-1906`; the correct action is `packages/contracts/src/failures.ts:200-203`; layout at `apps/portal/src/components/FailureCard.tsx:105-120`.
- **Severity:** `medium`. Addressed to somebody else, which undermines the rest of the card.
- **Decision needed:** `fix`.
- **Raised by:** [`sandbox/timeouts-and-limits.md`](sandbox/timeouts-and-limits.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-26: Floors print as ordinary scores in the terminal

- **Where the user meets it:** A Week 3 student reads a local report and cannot tell "Chance MRR" from "Text MRR".
- **What happens / what was expected:** The metric role now survives in local reports and syncs (`b8ae7ce`, `99281c5`), so the portal can draw floors. `cogworks report` and `run` still print a floor as a plain row. Expected: the terminal makes the distinction the run page makes.
- **Why (from the code):** `python/cogbench/src/cogbench/runner.py:187-192` and `python/cogbench/src/cogbench/models.py:112-113` (role recorded and read back); `python/cogbench/src/cogbench/cli.py:239-247` (the printer ignores it).
- **Severity:** `medium`. It contradicts a rule the platform enforces in the browser.
- **Decision needed:** `fix`.
- **Raised by:** [`terminal/report.md`](terminal/report.md#open-questions-and-verification), [`terminal/run.md`](terminal/run.md#open-questions-and-verification)
- **Status:** open. Reproduced locally from the candidate tree by printing a hand-written report with a floor metric. Same on beta.

### B-27: A batch of live events applies partially and reports failure

- **Where the user meets it:** After a flaky `--live` run, the team's bubble holds some of the run's events and the CLI was told the batch failed.
- **What happens / what was expected:** The batch handler loops sequentially, so a throw on event n leaves events 0 to n-1 applied and returns a 4xx. Expected: the batch is atomic, or the response says how far it got.
- **Why (from the code):** `apps/portal/worker/routes/local-runs.ts:400-417`; throws at `:84` and `:114`.
- **Severity:** `medium`. The sequence guard makes a retry mostly safe, by accident rather than contract.
- **Decision needed:** `fix`.
- **Raised by:** [`cross-cutting/live-updates.md`](cross-cutting/live-updates.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-28: The connections page polls forever while no device is linked

- **Where the user meets it:** A student sitting on `/connections` during a link, which is where they are told to sit.
- **What happens / what was expected:** The query refetches every four seconds until at least one device exists. Expected: the poll backs off or stops after a bounded window.
- **Why (from the code):** `apps/portal/src/lib/queries.ts:129-137`.
- **Severity:** `medium`. Battery and request volume rather than correctness.
- **Decision needed:** `fix`.
- **Raised by:** [`foundations/the-ask.md`](foundations/the-ask.md#open-questions-and-verification), [`terminal/link.md`](terminal/link.md#open-questions-and-verification), [`cross-cutting/live-updates.md`](cross-cutting/live-updates.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-29: A member added from the team page or the admin console gets write access the portal never checked

- **Where the user meets it:** An admin or instructor adds a teammate. The add succeeds; the teammate is refused later, at run time, with a message about GitHub permission.
- **What happens / what was expected:** Both add paths store the `write` role unconditionally, while `POST /team/join` reads GitHub first. Adding the fork's GitHub owner this way stores them as `write`, which is what makes B-65 a dead end. Expected: the same check, on the screen where the person who can fix it is standing.
- **Why (from the code):** `apps/portal/worker/routes/team-membership.ts:256-262` (literal at `:261`) and `apps/portal/worker/routes/admin.ts:413`, against join at `team-membership.ts:162-177`; the later refusal is `apps/portal/worker/services/run-actions.ts:138`.
- **Severity:** `medium`. Recoverable, but the error surfaces one screen and one person away from the fix.
- **Decision needed:** `fix`.
- **Raised by:** [`foundations/identity-and-roles.md`](foundations/identity-and-roles.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Retitled to include the admin console path. Same on beta.

### B-46: A failed hosted run carries one line: no exception class, no location, no log, none of the team's prints

- **Where the user meets it:** The page of any hosted run that fails in Evaluate.
- **What happens / what was expected:** The sandbox sends one `COG_ERROR` line capped at 500 characters, keeps only the last unindented stderr line without the exception class, writes the student log only after success, and sends no log with the failed event. The student reads "'NoneType' object is not subscriptable" with no `TypeError`, file or line, and no "Show the log", while the next step says to use "the recorded details". Expected: the class, the innermost frame, and the output a successful run would have kept.
- **Reproduce:** A practice run whose code prints, then raises.
- **Why (from the code):** `apps/runner-modal/src/cogworks_runner/modal_app.py:1017-1020`, `:1038`, `:2005-2038` (class dropped at `:2032-2034`), `:2318-2327`; `apps/portal/worker/routes/runner-events.ts:247-260` stores no log on failure (completion does, at `:226`); `packages/contracts/src/failures.ts:92-93`.
- **Severity:** `medium`. The student cannot learn what went wrong, which is the question the platform exists to answer.
- **Decision needed:** `fix`.
- **Raised by:** [`portal/the-run-page.md`](portal/the-run-page.md#open-questions-and-verification), [`sandbox/timeouts-and-limits.md`](sandbox/timeouts-and-limits.md#open-questions-and-verification)
- **Status:** open. Observed on hosted beta in `hosted-run_f5fc5babe5/failed-dom.txt` (no log region); same code at `2ff32fa`. The fixture provider scripts a log for failed runs (`pairs/b-run-failed-desk.png`), which hides this locally. The release owner has assigned the repair; nothing has changed in source yet.

### B-48: Staff without a team are routed into student onboarding and cannot reach Connections

- **Where the user meets it:** Every instructor or TA sign-in while they have no team.
- **What happens / what was expected:** Sign-in lands on `/signin`, which replaces to `/join`, or `/connect` after a cohort. The landing button says "Continue setting up" and the account menu "Continue setup", though the header hides "Get started" from staff. "Connections" also redirects into onboarding, so staff cannot link Discord or a device without joining a team. Leaving it again needs the admin console: staff who are not a stored team admin can remove themselves there (`apps/portal/worker/routes/admin.ts:423-451`); a stored team admin, which a team's creator always is, cannot be removed by anyone (B-07). Expected: staff without a team land on `/admin`, and the menu agrees with the header.
- **Reproduce:** Dev portal with `PLATFORM_OWNER_LOGINS` containing `owner`; `POST /api/dev/login {"login":"owner"}`; open `/signin`. It replaces to `/join`.
- **Why (from the code):** `apps/portal/src/App.tsx:34-39` (`nextStagePath` ignores `platformRole`) and `:129-136` (`/connections` behind the team gate); `apps/portal/src/routes/SignInPage.tsx:78-80`; `apps/portal/src/routes/Landing.tsx:50-51`; `apps/portal/src/components/UserMenu.tsx:218-221`; `apps/portal/src/components/Shell.tsx:52-55`.
- **Severity:** `medium`. Every staff member meets it on their first sign-in, and the path it offers is the student's.
- **Decision needed:** `fix`.
- **Raised by:** [`portal/sign-in.md`](portal/sign-in.md#open-questions-and-verification), [`foundations/identity-and-roles.md`](foundations/identity-and-roles.md#open-questions-and-verification), [`portal/join-or-make-a-team.md`](portal/join-or-make-a-team.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Beta's `App.tsx` is identical, so the routing is the same there. The release owner has assigned the repair; nothing has changed in source yet.
- **Status, local `17d26d9` (2026-10-02):** routing fixed in source (`App.tsx:37-43`). On the local fixture build a synthetic teamless staff login opening `/signin`, `/dashboard` and `/setup` settled on `/admin`. A pending device link was held there with an explanation and not approved. Not observed: the account menu's wording, and linking Discord while on no team. Connections still needs a team ([checkpoint](verification/checkpoint-17d26d9.md)).

### B-50: The leaderboard and team pages rank runs with different primary metrics together

- **Where the user meets it:** The public Language board, the Runs page, and the Discord bubble's team-best line.
- **What happens / what was expected:** A Week 3 run whose image side never bound gets `text_mrr` as its primary. The board takes each run's own primary and sorts by raw value, so a published withheld run ranks its Text MRR among other teams' Overall; on fixture data one commit read Overall 0.443 and Text MRR 0.772. `benchmarks.primary_metric_key` is read nowhere and promotion checks no key. The Runs list heads its column with the first run's label, so 0.75 Text MRR can sit under "Overall", and Discord can announce it as "a new team best". The run page compares like keys only. Expected: only like keys compared, or withheld runs ranked apart or not publishable.
- **Reproduce:** Run Week 3 once with weights and once without, promote and publish the withheld run, then read Runs, the board and the bubble.
- **Why (from the code):** `apps/portal/worker/services/leaderboard.ts:78`, `:108-112`; `apps/portal/worker/db/schema.ts:268`; `apps/runner-modal/src/cogworks_runner/modal_app.py:2051`; week3 `plugins.py:516-525` at `94c7e64f`; `apps/portal/src/components/RunList.tsx:38-40`, `:61`, `:138`; `apps/portal/worker/services/run-surfaces.ts:198-228`; contrast `apps/portal/src/routes/RunDetailPage.tsx:459-462`.
- **Severity:** `medium`. A public order that compares two measures.
- **Decision needed:** `product call`.
- **Raised by:** [`portal/the-leaderboard.md`](portal/the-leaderboard.md#open-questions-and-verification), [`portal/promote-to-the-leaderboard.md`](portal/promote-to-the-leaderboard.md#open-questions-and-verification), [`sandbox/scoring-and-refusals.md`](sandbox/scoring-and-refusals.md#open-questions-and-verification), [`foundations/what-the-portal-claims.md`](foundations/what-the-portal-claims.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Board and bubble same on beta; beta's run list has no column heading. The release owner is investigating which measure each board ranks by; nothing has changed in source yet.
- **Status, local `17d26d9` (2026-10-02):** the product call is made in source. Publication, the board and team best use the catalog's `primary_metric_key`, and a run without it cannot be published (`run-eligibility.ts:154-168` at `17d26d9`). On the local fixture build, an official run with only its `overall` row removed showed the refusal sentence in place of Publish. The API answered `409 not_selectable` and a signed-out board omitted the team ([checkpoint](verification/checkpoint-17d26d9.md)). The lead reports the stored selection was unchanged; the saved result does not record that. The partial result was synthetic. Not observed: the Runs list heading, Discord's team best, and a benchmark-produced withheld run.

### B-51: Team pages call a result public while the leaderboard hides it, and its attempts stay spent

- **Where the user meets it:** A team that published Recognition v2 before migration 0044, or any published run with no primary metric.
- **What happens / what was expected:** The run page says "This result is your team's public entry. See it on the leaderboard." and the Runs page lists it under "On the leaderboard", but the board drops selections from an older scorer version and runs with no primary. Migration 0044 changed the scorer inside version 2, and attempts used under the old scorer still count, so a team at three cannot get back on. Expected: the team's pages use the board's predicate, and a scorer change is a new version or returns attempts.
- **Reproduce:** The setup in `leaderboard-scorer-version.test.ts`, then open the selected run's page.
- **Why (from the code):** `apps/portal/worker/http/serializers.ts:229`; `apps/portal/worker/routes/dashboard.ts:110`; `apps/portal/worker/services/leaderboard.ts:58`, `:79`; `apps/portal/migrations/0044_week2_recognition_v2.sql:20-22`; `apps/portal/worker/services/run-accounting.ts:19-26`.
- **Severity:** `medium`. The team is told a result is public that nobody can see, and cannot replace it.
- **Decision needed:** `fix`.
- **Raised by:** [`portal/promote-to-the-leaderboard.md`](portal/promote-to-the-leaderboard.md#open-questions-and-verification), [`portal/the-leaderboard.md`](portal/the-leaderboard.md#open-questions-and-verification), [`cross-cutting/credit-and-quota.md`](cross-cutting/credit-and-quota.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Beta's server is identical; its pages were not checked.

### B-52: A board resolves `?benchmark=` to the highest version even when it is inactive

- **Where the user meets it:** Staff stage a new benchmark version inactive before opening it, which the new-version rule invites.
- **What happens / what was expected:** The service filters by id only and takes the highest version, so the board shows the empty inactive version with the footer "id / vN+1" and hides every published result on the active one. The page picks the active row but sends only the id. Expected: the active version's board.
- **Reproduce:** Insert vision-recognition v3 with `active=0` while v2 is active with selections; open Vision, Recognition.
- **Why (from the code):** `apps/portal/worker/services/leaderboard.ts:33-39`; `apps/portal/src/routes/LeaderboardPage.tsx:78-84`.
- **Severity:** `medium`. Staging a version empties a public board.
- **Decision needed:** `fix`.
- **Raised by:** [`portal/the-leaderboard.md`](portal/the-leaderboard.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-53: The admin page says "No hosted runs yet" for a team whose every run failed

- **Where the user meets it:** A TA scanning `/admin`.
- **What happens / what was expected:** The label sums practice and official usage, which count completed runs only. A team stuck on repeated failures, the team most worth opening, reads as never having run and sorts with idle teams. Expected: the label counts executions, or says none completed.
- **Reproduce:** A team with only failed hosted runs; open `/admin`.
- **Why (from the code):** `apps/portal/src/routes/AdminPage.tsx:108-110`, `:432`, `:474-478`; `apps/portal/worker/services/run-accounting.ts:60-69`.
- **Severity:** `medium`. It hides the teams that need help.
- **Decision needed:** `fix`.
- **Raised by:** [`cross-cutting/credit-and-quota.md`](cross-cutting/credit-and-quota.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta (beta `AdminPage.tsx:107`).

### B-54: A refused concurrent hosted start leaves a run-less console record that breaks `/cog` home and the Activity for the team

- **Where the user meets it:** Two teammates start the same benchmark close together; afterwards `/cog` and the Activity stop working for the whole team.
- **What happens / what was expected:** The start inserts the console record (the run surface) before the run, and the refusal throws without removing it. `/cog` picks that newest record, building its snapshot throws "Run surface has no run.", and the student reads "I couldn't reach Cog\*Portal just now." The Activity loads ten records with `Promise.all` and fails to open for everyone until ten newer ones exist. Expected: a refused start leaves no record.
- **Reproduce:** Two browsers press Start on the same benchmark within the window; then run `/cog`.
- **Why (from the code):** `apps/portal/worker/services/run-actions.ts:256` against `:300-302`, `:312-329`, `:369-375`; `apps/portal/worker/services/run-surfaces.ts:300`; `apps/portal/worker/rpc.ts:75-86`; `apps/portal/worker/routes/activity.ts:248-258`.
- **Severity:** `medium`. One ordinary race takes Discord down for a team.
- **Decision needed:** `fix`.
- **Raised by:** [`discord/commands.md`](discord/commands.md#open-questions-and-verification), [`discord/the-activity.md`](discord/the-activity.md#open-questions-and-verification)
- **Status:** open; read from code only at `2ff32fa`. A focused test would settle it. Same on beta.

### B-55: A channel the bot can no longer write is retried every two seconds forever

- **Where the user meets it:** Course staff remove the bot's Send Messages permission or delete a team channel.
- **What happens / what was expected:** Any later publication to that channel gets a 403, or a 404 on the repost. Only a 404 is handled; the alarm re-arms at 2 s with no cap and no status check, even for a settled run, and every failure counts against the bot token all teams share. Expected: an unwritable channel stops being retried and is reported.
- **Reproduce:** Remove the bot's permission in a bound channel, promote a run there, and watch the worker log for `run_surface_tick_failed`.
- **Why (from the code):** `apps/portal/worker/realtime/run-surface-hub.ts:163-176`; `apps/portal/worker/services/discord-messages.ts:278`, `:292-297`.
- **Severity:** `medium`. One team's channel change spends the shared rate limit indefinitely.
- **Decision needed:** `fix`.
- **Raised by:** [`discord/channel-messages.md`](discord/channel-messages.md#open-questions-and-verification)
- **Status:** open. The 403 delivery loop is confirmed as preexisting in the reliability work. It is a separate, finite repair from B-13: stop retrying a surface whose channel answers 403 or 404 and record why, without a new retry framework.

### B-56: The Discord leaderboard shows one arbitrary board and never marks the student's team

- **Where the user meets it:** `/cog view:leaderboard`.
- **What happens / what was expected:** The bot asks for the leaderboard with no benchmark, so the portal picks the active row with the highest version across all ids. A Week 2 student sees Recognition or Clustering, and ties are unordered. The bot bolds the student's rows, but no team id is passed, so nothing is bolded. Expected: the student's benchmark, with their team marked.
- **Reproduce:** Two active benchmarks with results; run `/cog view:leaderboard`.
- **Why (from the code):** `apps/portal/worker/services/leaderboard.ts:40-45`, `:105`; `apps/portal/worker/rpc.ts:32-35`; `apps/discord-bot/src/commands.ts:324-327`.
- **Severity:** `medium`. The view answers a question the student did not ask.
- **Decision needed:** `fix`.
- **Raised by:** [`discord/commands.md`](discord/commands.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-57: The bind prompt says only shared local runs will post; every hosted run posts

- **Where the user meets it:** A maintainer binds a team channel.
- **What happens / what was expected:** The prompt says "Cog will post one live bubble per explicitly shared local run here". After binding, any teammate's practice run started from the dashboard, and every promotion and publication, posts or edits a bubble there, with no `--live` involved and nothing on the dashboard saying so. Expected: the prompt describes what will post.
- **Reproduce:** Bind a channel, start a practice run from the dashboard, and watch the channel.
- **Why (from the code):** `apps/discord-bot/src/commands.ts:433` against `apps/portal/worker/services/run-actions.ts:315-329`, `:382` and `apps/portal/worker/routes/runs.ts:27`.
- **Severity:** `medium`. A consent sentence narrower than the behavior.
- **Decision needed:** `product call`. Fix the prompt, or post hosted runs only when a team opts in.
- **Raised by:** [`discord/channel-messages.md`](discord/channel-messages.md#open-questions-and-verification), [`discord/commands.md`](discord/commands.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-58: A signed-out browser loses the run a Discord or Activity link pointed at

- **Where the user meets it:** A student presses the portal link on a bubble, "Open Cog\*Portal" on `/cog`, or "See why it failed" in the Activity, and the system browser is signed out.
- **What happens / what was expected:** The stage gate sends them to `/signin` and remembers only `/connections` paths, so after sign-in they land on their next-stage page instead of `/run-surfaces/<id>` or `/runs/<id>`. Expected: return to the linked run.
- **Reproduce:** Sign out, press a bubble's portal link, sign in.
- **Why (from the code):** `apps/portal/src/App.tsx:68-72`; `apps/portal/src/lib/pending-return.ts:3-7`; `apps/portal/src/routes/SignInPage.tsx:79`, `:108`; links at `apps/discord-bot/src/commands.ts:168`, `:605`, `apps/portal/worker/services/discord-messages.ts:249`, `apps/portal/src/activity-main.tsx:309-315`.
- **Severity:** `medium`. Every Discord link to a run is lost on first use from a fresh browser.
- **Decision needed:** `fix`.
- **Raised by:** [`discord/commands.md`](discord/commands.md#open-questions-and-verification), [`discord/the-activity.md`](discord/the-activity.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Beta's `App.tsx` and `pending-return.ts` are identical.

### B-59: A `run --live` report names weights it never uploads, failing the next hosted run at that commit

- **Where the user meets it:** A Week 3 team runs `cogworks run --live`, then starts a hosted run at the same commit without syncing, or after an earlier sync.
- **What happens / what was expected:** The completed live report is stored with its weight receipts, and the newest report at a commit wins at dispatch. The hosted run fails before starting with "Required weight {path} has not been uploaded; sync the report again." No quota is used. Expected: live uploads the weights, or dispatch ignores receipts nothing uploaded, or the live run says to sync.
- **Reproduce:** Verification item RUN-14.
- **Why (from the code):** `apps/portal/worker/routes/local-runs.ts:116`; `apps/portal/worker/services/local-reports.ts:319-345`; `apps/portal/worker/services/weights.ts:362-370`; `apps/portal/worker/services/run-actions.ts:205-216`.
- **Severity:** `medium`. A live run silently undoes an earlier sync.
- **Decision needed:** `product call`. Choose which of the three behaviors is the contract.
- **Raised by:** [`terminal/run.md`](terminal/run.md#open-questions-and-verification), [`terminal/sync.md`](terminal/sync.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.
- **Status, `a6eef75` (2026-10-03):** still open as a product call; the refusal now comes earlier. A hosted run's job, weights included, is built before admission, so the start is refused with "Required weight {path} has not been uploaded; sync the report again." and no failed run is added to history (`apps/portal/worker/execution/runner.ts`, `prepareAdmissionJob`). Covered by `apps/portal/test/run-actions.test.ts` (incomplete weight uploads are refused before admission).

### B-60: A prepare killed for time or memory is reported as a dependency install failure

- **Where the user meets it:** The failure card after Install.
- **What happens / what was expected:** Prepare has no elapsed-time check, and anything unrecognized becomes `dependency_install`, so a prepare stopped at its 900 s budget or out of memory reads E-INSTALL "Dependency installation failed", with a reproduce command naming a `constraints.txt` no 2026 repository has. Discovery runs inside prepare for every 2026 repository (Install took 88 s on beta for one vision repository), so a slow search or heavy import is the likely route. Expected: the time or memory explanation the evaluate lanes give.
- **Reproduce:** A repository with no root file whose `setup.py` or a module import sleeps past 900 s. Whether Modal reports this as a return code or an exception is unrecorded.
- **Why (from the code):** `apps/runner-modal/src/cogworks_runner/modal_app.py:1558-1584`, `:2021`; `packages/contracts/src/failures.ts:31-39`.
- **Severity:** `medium`. The student is sent to fix dependencies that are fine.
- **Decision needed:** `fix`.
- **Raised by:** [`sandbox/prepare.md`](sandbox/prepare.md#open-questions-and-verification), [`sandbox/timeouts-and-limits.md`](sandbox/timeouts-and-limits.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-61: A refusal's notes reach the browser and are never drawn

- **Where the user meets it:** The run page of a refused hosted run.
- **What happens / what was expected:** The sandbox forwards the verdict's notes (what the search learned that the headline does not say), the worker stores them, the API serves them, and the card declares the field and renders nothing. `cogworks check` prints them. Expected: the card shows them; this is the computed-then-dropped failure the working brief warns about.
- **Reproduce:** A not_wired repository whose `cogworks check` prints notes; compare with its hosted run page.
- **Why (from the code):** `apps/runner-modal/src/cogworks_runner/modal_app.py:1073-1077`; `packages/contracts/src/protocol.ts:139`; `apps/portal/worker/http/serializers.ts:248-256`; `apps/portal/src/components/RefusalCard.tsx:25`; `python/cogbench/src/cogbench/report.py:347-348`.
- **Severity:** `medium`. The explanation exists and the student never sees it.
- **Decision needed:** `fix`.
- **Raised by:** [`cross-cutting/refusals-and-disclosure.md`](cross-cutting/refusals-and-disclosure.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.
- **Status, `f03ebfa` (2026-10-03):** fixed in source and seen locally. `RefusalCard` draws the first note under the headline in the reading face and folds the rest behind a `Veil` labelled "1 more note from the search" or "{n} more notes from the search", closing as "Fewer notes" (`apps/portal/src/components/RefusalCard.tsx:100-126`, `:177`). Seen on the real run page with a synthetic `not_wired` refusal row carrying three notes, local D1 only (`~/.long-run/cogportal/evidence/student-recovery/screens/runpage-not-wired-notes.png`), and on the gallery fixture at desktop, at 375 px and expanded by keyboard (`screens/gallery-refusal-notes-*.png`). Covered by `apps/portal/test/refusal.test.ts`. Not seen: a hosted refusal from a real repository.

### B-62: The E-OUTPUT card promises checks that do not run

- **Where the user meets it:** Any hosted run refused for invalid output.
- **What happens / what was expected:** The next step says "Validate your output locally with the schema check" and offers `cogworks test`; no schema check exists, and `cogworks test` scores the small cases. The explanation says extra fields and out-of-range values are rejected; the check ignores extra fields and checks no range. The vision override names out-of-range boxes, which Week 2 does not have, and the language override names checks the controller does not make. The detail sentence beside the card is exact. Expected: copy that describes the checks that run.
- **Reproduce:** Return a NaN or a short list from a v2 adapter and read the card.
- **Why (from the code):** `packages/contracts/src/failures.ts:119-126`, `:187`, `:210`; `apps/runner-modal/src/cogworks_runner/prediction_validation.py:194-271`, `:349-433`.
- **Severity:** `medium`. It sends the student to a tool that does not exist.
- **Decision needed:** `fix`.
- **Raised by:** [`sandbox/scoring-and-refusals.md`](sandbox/scoring-and-refusals.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.
- **Status, `f03ebfa` (2026-10-03):** fixed in source. The catalog entry is titled "Results came back in a shape scoring can't read"; the explanation names the check the runner makes ("one per case, each of the type this benchmark scores, with finite numbers where scoring does arithmetic"); the next step defers to the runner's line and says `cogworks test` "doesn't repeat the runner's check" (`packages/contracts/src/failures.ts:138-149`). The vision and language overrides that named extra fields, out-of-range boxes, ids outside the pool and more than k are deleted. The fixture's raw-tuples details are now the runner's own sentences (`packages/contracts/src/fixtures.ts:84-87`, matching `prediction_validation.py:412`, `:427`, `:447`). Seen locally on the real run page for fixture run `run_9958511cc1` on `vision-clustering` (`~/.long-run/cogportal/evidence/student-recovery/screens/runpage-e-output-raw-tuples-f03ebfa.png`, headless Chromium at `f03ebfa`): title, the runner's detail line, the next step and `cogworks test --benchmark vision-clustering` as committed. The explanation sits behind the closed "Show details". An earlier screenshot in the same folder without the suffix shows a pre-commit draft of the next step. Covered by `apps/portal/test/failure-presentation.test.ts`.

### B-64: Discord and the console put a student's login beside a score

- **Where the user meets it:** `/cog` local notes, the team channel's run bubble, `/run-surfaces/{id}` and the Activity.
- **What happens / what was expected:** Discord's local view leads each line with the author's login in bold before that report's score, and the bubble and console name the actor beside the primary metric. The Runs page dropped its author column because "a name beside a score reads as that student's grade", and the working brief forbids per-person numbers in any form. Expected: one answer across surfaces.
- **Reproduce:** Sync a local report and open `/cog` local notes.
- **Why (from the code):** `apps/discord-bot/src/commands.ts:373`; `apps/portal/worker/services/discord-messages.ts:142`; `apps/portal/src/components/RunConsole.tsx:324`, `:329-333`; contrast `apps/portal/src/components/LocalReportsTable.tsx:16`.
- **Severity:** `medium`. It breaks a stated rule on the surfaces students see most.
- **Decision needed:** `product call`. Drop the name next to a score, or decide an actor line is not a per-person number and say why.
- **Raised by:** [`foundations/what-the-portal-claims.md`](foundations/what-the-portal-claims.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta (beta `RunConsole.tsx:309`).
- **Status, integrated `93dfa5e` source (2026-10-02):** the three displays named above no longer print the login beside a score. The console drops `@{login}` (`d687c74`; the actor stays in the server's records, `apps/portal/src/components/RunConsole.tsx:364`). Discord's local view leads each line with the commit (`3903291`, `apps/discord-bot/src/commands.ts:378`), and the run bubble no longer writes "by {name}" (`apps/portal/worker/services/discord-messages.ts:139-147`). Read from code and the suite; not seen in Discord. `17d26d9` still has all three.

### B-65: A team creator with only GitHub write access loses settings on first save, which can leave the team with no admin

- **Where the user meets it:** The team page, for a student who created the team from a teammate's fork.
- **What happens / what was expected:** Creating a team needs only write access but stores the creator as admin, so the page shows every control. The first rename or add returns "Your GitHub permission on the team repository is no longer admin, so team settings are read-only for you." and stores them as write. Adding the fork owner also stores them as write (B-29), and the admin check reads the stored role before GitHub, so nobody can manage the team again. Expected: store the creator's real role, or let the GitHub admin claim it.
- **Reproduce:** A creates a team from B's public fork where A has write. A adds B from the palette, then renames the team.
- **Why (from the code):** `apps/portal/worker/routes/github.ts:195-203`; `apps/portal/worker/github/team.ts:73`; `apps/portal/worker/routes/team.ts:145-150`, `:179-188`; `apps/portal/worker/routes/team-membership.ts:261`; `apps/portal/worker/routes/admin.ts:413`.
- **Severity:** `medium`. A team can lock itself out with two ordinary clicks; an instructor can still act.
- **Decision needed:** `product call`.
- **Raised by:** [`portal/the-team-page.md`](portal/the-team-page.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-66: The staff roster promises a co-instructor "the same view"; they get an empty TA workspace

- **Where the user meets it:** The owner's Platform staff section, then the added person's `/admin`.
- **What happens / what was expected:** The empty roster says "Owners already have access; add a GitHub login below to give someone else the same view." A rostered non-owner then sees "TA workspace" and "No teams assigned to you yet." until the owner assigns them to each team, one row at a time. The section's own note says they "see the teams assigned to them". Expected: copy that matches the access.
- **Reproduce:** As owner, add a login to Platform staff, sign in as it, open `/admin`.
- **Why (from the code):** `apps/portal/src/routes/AdminPage.tsx:828-829` against `:770` and `:81`; `apps/portal/worker/routes/admin.ts:298-302`.
- **Severity:** `medium`. An instructor is told a colleague can help and the colleague sees nothing.
- **Decision needed:** `fix`.
- **Raised by:** [`portal/admin.md`](portal/admin.md#open-questions-and-verification)
- **Status:** open. Roster copy visible in local fixture `pairs/b-admin-active-desk.png`; the empty workspace is read from code. Beta has the roster without the "same view" sentence.
- **Status, local `17d26d9` (2026-10-02):** the roster note reads "Staff see only the teams assigned to them." (`AdminPage.tsx:827-828` at `17d26d9`). On the local fixture build a staff login added there saw the TA workspace with "No teams assigned to you yet.", which the note now predicts ([checkpoint](verification/checkpoint-17d26d9.md)).

### B-68: A clean Language run opens by saying the scorer wrote no finding

- **Where the user meets it:** The first thing on a succeeded run page, in the largest type on the page, whenever the benchmark wrote no diagnostic: "The scorer didn't write a finding for this run. Its readings are below." (`apps/portal/src/routes/RunDetailPage.tsx:494`), or the sweep variant "The scorer didn't write a sentence for this run. Its curve is below, with the readings under it." (`:493`). Both fixture runs in `pairs/b-run-success-desk.png` and `b-run-official-desk.png` open this way.
- **What happens / what was expected:** The page treats the first benchmark diagnostic as the finding (`RunDetailPage.tsx:464`, `:483`), but no benchmark has a finding field; each writes diagnostics only when something is notable. Week 1 inserts a sentence from its catalog sweep when the sweep yields one (`benchmarks/week1/.../plugins.py:232-240`). Recognition's diagnostics are conditional on what the run got wrong (`benchmarks/week2/.../metrics.py:118-153`); the hosted beta run `run_f93ba19397` led with one. Clustering writes a stability sentence only with seed repeats and a spread at or under 0.02 (`week2/.../plugins.py:280-340`). Language writes one for failures, withheld scores and rewrite gaps (`week3/.../metrics.py:625-640`, `plugins.py:498-570`), so a clean, fully bound Language run opens with the platform describing its own plumbing. The sentence is honest, and the design rule it serves is right; what is missing is a sentence from the benchmark. Expected: every benchmark writes a lead sentence from its own metrics on every scored run, the way Week 1's sweep sentence and Recognition's cutoff sentence do, and the portal keeps its current fallback for a run with no diagnostics.
- **A related open question, not a confirmed defect:** Week 3 appends `adapter: mapped {alias} -> {role}` to the same list after its metric notes (`plugins.py:500`, `adapters.py:183-188`). On a declared-adapter run with no other diagnostic, that line would become the finding, under the margin note "The benchmark's scorer wrote this sentence from the numbers it measured". No run has shown it; a fixture with an aliased adapter would settle it.
- **Reproduce:** A hosted Language practice run on a repository whose image side binds and that triggers no rewrite gap. Not yet run on any build.
- **Severity:** `medium`. It lands on the most common good outcome of the week with the least obvious result, and it replaces the instrument's sentence with an apology.
- **Decision needed:** `product call` for the benchmark owners: whether a lead sentence is part of the plugin contract. Fix in the benchmark submodules, not in portal copy; that is a new benchmark version under the brief's versioning rule if it changes what a run reports.
- **Raised by:** the lead's evidence review of the matched pairs; [`portal/the-run-page.md`](portal/the-run-page.md#open-questions-and-verification).
- **Status:** **confirmed** on deployed `ed2b194`. Hosted run `run_d11b5e5e2e` (`SamGu-NRX/Language_Module_Capstone@8789361`, succeeded, Overall 0.4126, 9 cases, 19 metrics) leads with "The scorer didn't write a sentence for this run. Its curve is below, with the readings under it." (`beta-qa/live-language-ed2b194/README.md`, `hosted-result.txt`); its local report's diagnostics are empty too. The lead was the fallback, not adapter text. The producer repair on benchmark pin `94c7e64` is owned by Opus worker `0e3d690b-079f-408d-926b-15a8e70f5d2c`; do not duplicate it. Earlier evidence: read from code at `2ff32fa` and the pinned submodules, and the empty state on local fixture data. The per-benchmark conditions above were checked in a fresh Sol audit. Beta's older page says "The scorer had no notes on this run." below the metrics instead of leading with it (beta `RunDetailPage.tsx:315`), so the redesign is what moved the absence to the top.
- **Status, `f618038` full path (2026-10-02):** fixed for a clean Language run. The producer repair is Week 3 `9e4dcff` ("lead a clean run with search against retrieval"), inside pin `4b17554`; `94c7e64` above is not the commit that carries it. The full hosted path at `f618038`: a local Worker dispatching to the deployed beta runner v48 (deployed from `17d26d9`), with signed callbacks into local D1 and the run page reloaded in Chromium. Practice run `run_6867b9fefa` (`bb08255`, Overall 0.1540) opens on "On the same rewritten queries, your search scored 0.010 …", not the fallback; the benchmark writes that sentence only when every case ran and nothing was withheld. The same repair moves adapter mapping notes after the metric notes, which answers the related open question above in source. Recognition, Clustering and Audio leads were not rechecked.

### B-71: A window left visible while another signs in as someone else changes the other account's team

- **Where the user meets it:** Two browser windows side by side on one computer, the first on the Team page or Runs page as Ann. In the second, Ann signs out and Ben signs in. The first window still shows Ann's team.
- **What happens / what was expected:** Nothing told the first window that the account had changed. The restore gate rechecks the session only when a page is hidden and shown again, and TanStack Query v5 listens only to `visibilitychange`, so a window that never left the screen kept Ann's header and pages. Rename, Change repository, Add someone, Remove and Run practice benchmark named no team; the server applied each to the team of whoever the cookie said was signed in. A rename typed on Ann's page renamed Ben's team, and a practice start would have used one of Ben's team's practice runs. Expected: a page acts only on the team it shows, and a window learns who is signed in when it is used again.
- **Reproduce:** Two visible windows. Sign in as an admin of team A in the first and open `/team`. In the second, sign out and sign in as an admin of team B. Back in the first, press Rename, type a name, Save. Check which team changed.
- **Why (from the code):** at `2ff32fa` and on beta, `PATCH /team` and `POST /team/repository` start with `requireTeamAdmin(c)` and write to `auth.team.id`, and `POST /runs/practice` starts with `requireTeam(c)` (beta `apps/portal/worker/routes/team.ts:476-477`, `:491`; `apps/portal/worker/routes/runs.ts:24-25`). `RestoreGate.tsx` listens to `visibilitychange`, `pagehide` and `pageshow` only.
- **Severity:** `medium`. It needs two visible windows and an account switch, which is uncommon, but the result is a silent change to someone else's team.
- **Decision needed:** `fix`.
- **Raised by:** the student-recovery lane's cache investigation, after the restore gate's hide-and-return path checked out.
- **Status, `8477efb` source (2026-10-03):** fixed in four commits; not deployed, and under a fresh audit.
  - `dfd8930`: the four team routes carry the team the page showed (`teamId` in the `PATCH /team`, `POST /team/repository` and `POST /team/members` bodies, `?teamId=` on `DELETE /team/members/:login`). The server compares it with the caller's team before the GitHub role check and before any write. A mismatch answers 409 "You're on {team} now, not the team this page showed. Reload to see it."; a missing id answers 409 "This page is out of date. Reload it and try again." (`apps/portal/worker/routes/team.ts:217`, `:519`, `:534`; `apps/portal/worker/routes/team-membership.ts:261`, `:320`).
  - `8477efb`: `POST /runs/practice` does the same before quota, GitHub or run creation (`apps/portal/worker/routes/runs.ts:28`); the shared check is `requireShownTeam` (`apps/portal/worker/auth/session.ts:187`). Discord and console run actions resolve their own actor and are unchanged.
  - `e0c3b5d` and `740b790`: window focus reruns the gate's session check (`apps/portal/src/components/RestoreGate.tsx:141`, `:197`). The page stays shown while it reads; a different account conceals it and reloads; a failed read conceals it behind "Try again".
  - Status, `9f94f38` and `c9393df` (2026-10-03), after a fresh audit of the above: the page no longer stays shown while focus reads. A click could act on it before the answer, and a read sent before a blur could answer the focus after it. Blur and focus are now treated like hide and return: blur discards any read in flight, and focus conceals at once and checks with a fresh read. The Runs page also offers no start while the session and the dashboard name different teams. In two visible headless windows, a real click on Rename and on Run practice benchmark in the stale window fired `focus` before `pointerdown` and `click`; the page was already inert, nothing was sent, and the window reloaded as the other account (`real-input-rename.json`, `real-input-practice.json`).
  - Status, `1a2887b` (2026-10-03): the account a return is checked against is now recorded at blur, not read at focus. A visible, blurred window's cache could still change: a mutation sent before the blur, answering after another window signed in, refetched the session as the new account, and focus then took that account as the one the page was painted for and reopened the old account's page for it. The record is kept until a check confirms the account. Blur still conceals nothing, so a page beside the terminal stays readable and a live run there stays watchable; focus conceals and checks as before. Evidence: `apps/portal/test/restored-document.test.ts` (that sequence reloads and never shows the old setup command again; a blur leaves the page and an open confirm as they were, and the return closes the confirm and keeps the same page). Not driven in a browser.
  - Evidence, synthetic local data on the dev server, full Chromium in new-headless mode with two windows both reporting `visibilityState` "visible":
    - Before the fix, the stale rename renamed team B (`~/.long-run/cogportal/evidence/student-recovery/cache-switch/restore-windows.json`, `teams-after-rename.txt`); the name was restored and the rows diffed identical.
    - After it, the stale window's Save was refused with the reload sentence and both team rows stayed byte-identical (`shown-team-guard.json`).
    - A click into the stale window, through the browser's input pipeline, fired `focus` and reloaded it as Ben within 150 ms (`shown-team-click.json`).
    - Tests: `team-admin-permission.test.ts`, `restored-document.test.ts`, `practice-shown-team.test.ts`.
  - Not verified:
    - A desktop window switch. Activating a window over DevTools raised no `focus` event in headless mode (`shown-team-activate.json`), and a real switch would mean foregrounding windows on a shared machine. The server refusal covers that window either way.
    - GitHub sign-in in the second window; dev sign-in swapped the cookie instead.
    - The practice-start guard in a browser; it is covered by tests only.
    - A hidden-then-returned tab was already handled by the restore gate before this (`restore-hide.json`).

## Low

### B-03: Two gates disagree about which team members Discord serves

- **Where the user meets it:** Nobody, today. Filed because the day a fourth role exists, a member gets "I couldn't reach Cog\*Portal just now." from `home` while the rest of the bot works.
- **What happens / what was expected:** `getDiscordTeamStatus` accepts any membership row; `getRunSurface` allows only `admin`, `maintain` and `write`. No write path can store any other role. Expected: one predicate for both.
- **Why (from the code):** `apps/portal/worker/services/discord.ts:154-159` against `apps/portal/worker/services/run-actions.ts:78-79`; the role mapping is `apps/portal/worker/github/permissions.ts:3` and `apps/portal/worker/routes/team.ts:182-184`; the collapse is `apps/discord-bot/src/index.ts:46`.
- **Severity:** `low`. Unreachable, and nothing fails a build if one side changes.
- **Decision needed:** `fix`. Share the role predicate.
- **Raised by:** [`discord/commands.md`](discord/commands.md#open-questions-and-verification), [`foundations/the-team-and-the-repository.md`](foundations/the-team-and-the-repository.md#open-questions-and-verification)
- **Status:** latent; code read at `2ff32fa`. Same on beta.
- **Status, `f03ebfa` (2026-10-03):** the gate mismatch is unchanged. What such a member would read changed: `discordRunActor`'s refusal is an `ApiHttpError` (`apps/portal/worker/services/run-actions.ts:81-83`), so the bot would now show "Current write access to the team repository is required." rather than the generic sentence (B-19).

### B-09b: Hosted practice confirmations say every run uses quota; only completed runs do

- **Where the user meets it:** Confirming Verify hosted, Rerun or Retry in `/cog`, or a start in the console.
- **What happens / what was expected:** Verify says "It's practice, and it uses one of this benchmark's hosted practice runs.", rerun says it "uses another", and the console says "This uses one of the team's shared practice runs." A failure uses none. The Retry confirmation says nothing about quota, though a completed retry counts. Expected: the cost stated with its condition.
- **Why (from the code):** `apps/discord-bot/src/commands.ts:547`, `:553`, `:574`; `apps/portal/src/components/RunConsole.tsx:272`; usage counts completed executions in `apps/portal/worker/services/run-accounting.ts`.
- **Severity:** `low`. It errs toward caution.
- **Decision needed:** `fix`.
- **Raised by:** [`cross-cutting/credit-and-quota.md`](cross-cutting/credit-and-quota.md#open-questions-and-verification), [`discord/commands.md`](discord/commands.md#open-questions-and-verification)
- **Status:** narrowed; code read at `2ff32fa`. Retitled because `99281c5` removed "free"; the copy now overstates the cost instead. Same on beta.

### B-12: `/cog view:connect` for an already-linked student is a dead end

- **Where the user meets it:** A student who has already linked Discord picks "Connect account" from `/cog`.
- **What happens / what was expected:** The already-linked branch returns the home view without the portal origin, so it drops "Open Cog\*Portal" and the menu's portal link. Confirming a link now requires a team, so the old "Refresh"-only card that names a portal action needs a student who linked and then lost their team. Expected: the link is present, as on every other path to the card.
- **Why (from the code):** `apps/discord-bot/src/commands.ts:239` omits the argument; the no-origin branch is `:105-109`; the team requirement is `apps/portal/worker/routes/connections.ts:59`, `:76`.
- **Severity:** `low`, down from high. The common case loses a link, not the way forward.
- **Decision needed:** `fix`. One argument.
- **Raised by:** [`discord/commands.md`](discord/commands.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-15: Re-linking a device accumulates live tokens that nothing revokes

- Every completed handshake inserts a device row, and nothing revokes the previous one; each lives sixty days. The list now shows "Last used {date}" or "Linked {date}, not used yet", so the device a terminal holds can be told apart, and revoking asks first.
- **Why:** `apps/portal/worker/routes/connections.ts:257`; `apps/portal/worker/auth/device.ts:41`; `apps/portal/src/routes/ConnectionsPage.tsx:317-326`.
- **Severity:** `low`, down from medium. **Decision needed:** `fix`.
- **Raised by:** [`terminal/link.md`](terminal/link.md#open-questions-and-verification)
- **Status:** narrowed; code read at `2ff32fa`. Same on beta.

### B-17: The longest paragraphs in `cogworks check` are not wrapped

- The could-not-look headline is now about 105 characters, but the stall next step still runs past 200, and the new "Could not read:" and "Raised while trying:" blocks are also unwrapped.
- **Why:** `python/cogbench/src/cogbench/report.py:344-355`; `python/cogbench/src/cogbench/verdict.py:470-474`; `python/cogbench/src/cogbench/resolve.py:3717`.
- **Severity:** `low`. **Decision needed:** `fix`.
- **Raised by:** [`terminal/check.md`](terminal/check.md#open-questions-and-verification)
- **Status:** narrowed; rendered locally with synthetic input. Retitled because the headline is no longer one of the long ones. Same on beta.

### B-18: The most ordinary failure verdict has no next step

- The next step is empty when nothing is missing, and the code now calls that deliberate, while `report.py` still promises "the single next thing". The verdict's "Raised while trying:" block gives some lead.
- **Why:** `python/cogbench/src/cogbench/resolve.py:3717-3729`; `python/cogbench/src/cogbench/report.py:6-8`; `python/cogbench/src/cogbench/verdict.py:327-330`.
- **Severity:** `low`. **Decision needed:** `product call`. Keep the choice and correct the docstring, or write a next step that says to read the trace.
- **Raised by:** [`terminal/check.md`](terminal/check.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-30: Churn events record one author while the rest of the process panel credits co-authors

- Stage footprint and ownership read `Co-authored-by:` trailers; the churn event still records one `authorLogin`. The page no longer shows a churn author, so the two never disagree on screen.
- **Why:** `apps/portal/worker/services/process-signals.ts:422-425`; `apps/portal/worker/routes/team.ts:464`; `apps/portal/src/components/ProcessPanel.tsx:478-499`.
- **Severity:** `low`, no visible effect. **Decision needed:** `fix`. Carry co-authors or drop the field.
- **Raised by:** [`portal/the-team-page.md`](portal/the-team-page.md#open-questions-and-verification)
- **Status:** narrowed; code read at `2ff32fa`. Retitled because the visible half is gone. Same on beta.

### B-31: Unreleased benchmarks' titles and summaries are public

- The catalog has no active filter and its route is unauthenticated. Inactive leaderboard tabs now deliberately show archive rows with "isn't calibrated for this cohort yet", so the clickable tab is design. Vision Overall still requests its board with no Vision benchmark active.
- **Why:** `apps/portal/worker/services/catalog.ts:8-13`; `apps/portal/worker/routes/benchmarks.ts:9-12`; `apps/portal/src/routes/LeaderboardPage.tsx:121-133`, `:213-214`, `:241-283`.
- **Severity:** `low`. **Decision needed:** `product call`. Whether an unopened week's title and summary should be public.
- **Raised by:** [`portal/the-leaderboard.md`](portal/the-leaderboard.md#open-questions-and-verification)
- **Status:** narrowed; code read at `2ff32fa`. Retitled to the remaining question. Same on beta.

### B-32: The device has two different names

- `cogworks link` prints the hostname; the portal and `cogworks status` show the name typed in the browser, which defaults to "CogWorks CLI" on every machine. The approval form now hints "So you can tell your machines apart in the list below."
- **Why:** `python/cogbench/src/cogbench/cli.py:1271` against `apps/portal/src/routes/ConnectionsPage.tsx:46`, `:204`.
- **Severity:** `low`. **Decision needed:** `fix`.
- **Raised by:** [`terminal/link.md`](terminal/link.md#open-questions-and-verification), [`terminal/status.md`](terminal/status.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-33: `--json` output is followed by a plain-text line

- `check`, `run` and `test` with `--json --update-setup` print "setup: updated ..." to stdout after the JSON document. Every other status line goes to stderr.
- **Why:** `python/cogbench/src/cogbench/cli.py:211`.
- **Severity:** `low`. **Decision needed:** `fix`. Send it to stderr.
- **Raised by:** [`terminal/run.md`](terminal/run.md#open-questions-and-verification), [`terminal/check.md`](terminal/check.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-34: A malformed response or file gives a traceback instead of a sentence

- `cogworks status` and `cogworks report` read fields by subscript, and `KeyError` is not in the caught tuple. `cogworks report` on a file holding `{}` prints `KeyError: 'reportId'` and exits 1. The sync half is gone because sync no longer calls git.
- **Why:** `python/cogbench/src/cogbench/cli.py:1344-1353`, `:1361`; `python/cogbench/src/cogbench/models.py:303`.
- **Severity:** `low`. **Decision needed:** `fix`. Add `KeyError` to the tuple.
- **Raised by:** [`terminal/status.md`](terminal/status.md#open-questions-and-verification), [`terminal/report.md`](terminal/report.md#open-questions-and-verification), [`terminal/sync.md`](terminal/sync.md#open-questions-and-verification)
- **Status:** open; reproduced locally from the candidate tree. Same on beta.

### B-35: The official-attempt limit is still hardcoded in the Discord bot

- The portal now reads `OFFICIAL_LIMIT` everywhere and the admin page prints no denominator. The bot still writes 3 four times, and `failures.ts` still writes "15-minute".
- **Why:** `apps/discord-bot/src/commands.ts:189`, `:190`, `:560`, `:563`; `packages/contracts/src/failures.ts:101`.
- **Severity:** `low`. **Decision needed:** `fix`.
- **Raised by:** [`cross-cutting/credit-and-quota.md`](cross-cutting/credit-and-quota.md#open-questions-and-verification), [`portal/admin.md`](portal/admin.md#open-questions-and-verification), [`discord/commands.md`](discord/commands.md#open-questions-and-verification)
- **Status:** narrowed; code read at `2ff32fa`. Beta's console also hardcodes it (beta `RunConsole.tsx:271`).

### B-37: `cancelled` is a status nothing can ever produce

- No code writes it and there is no cancel endpoint, yet the redesign added copy for it ("Cancelled {ago}."). The rail draws it as pending and the console as stopped.
- **Why:** `packages/contracts/src/schema.ts:35`, `:40`; `apps/portal/worker/db/schema.ts:328`; readers at `apps/portal/src/routes/DashboardPage.tsx:457`, `apps/portal/src/components/RunConsole.tsx:80`, `:87`, `:96`, `apps/portal/worker/services/discord-messages.ts:213`, `packages/discord-kit/src/rails.ts:25`.
- **Severity:** `low`. **Decision needed:** `product call`. Add cancellation, or remove the status.
- **Raised by:** [`foundations/the-run.md`](foundations/the-run.md#open-questions-and-verification), [`portal/watching-a-run.md`](portal/watching-a-run.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-38: Four dead code paths and one tautological test

- `open_portal` has a button label but no place in the priority list (`apps/discord-bot/src/commands.ts:163`).
- `open_console` inside `executeCommand` returns "That run action is not available." for a button the product generates; only the pre-intercept in `apps/discord-bot/src/index.ts:104` saves it (`commands.ts:537`).
- `unlinkDiscord` has no caller in the bot (`apps/portal/worker/rpc.ts:57`).
- New: `home`'s priority list holds `run_again` and `rerun_hosted` behind `open_console`, which every surface carries, so neither is chosen (`apps/portal/worker/services/run-surfaces.ts:346`).
- `apps/discord-bot/test/refusal-message.test.ts:16` is still true of every string, and the real test (`apps/portal/test/run-surfaces.test.ts:428`) does not pin the 300-character cut, which can stop mid-word (`apps/portal/worker/services/discord-messages.ts:233`).
- `GITHUB_TEAM_VIDEO` was removed in `faa3fc3`. Fixed.
- **Severity:** `low`. **Decision needed:** `fix`.
- **Raised by:** [`discord/commands.md`](discord/commands.md#open-questions-and-verification), [`portal/connect-a-repository.md`](portal/connect-a-repository.md#open-questions-and-verification), [`cross-cutting/refusals-and-disclosure.md`](cross-cutting/refusals-and-disclosure.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.

### B-41: Small copy and consistency slips

Grouped because each is one string or one line.

- `"Failed."`, `"Update failed."` and `"Changing the repository failed."`: fixed in `676e626`; each now gives a next step (`apps/portal/src/routes/TeamPage.tsx:228`, `:309`, `:449`, `:556`). Beta still says "Failed." (beta `TeamPage.tsx:339`).
- `COGBENCH DEVICES`: fixed in `99281c5` and `5194c82`; the section is now "CogWorks tool".
- `RequireStaff` still redirects a non-staff visitor to `/` silently while the worker answers "Staff access required." (`apps/portal/src/App.tsx:95-96`, `apps/portal/worker/auth/roles.ts:91`).
- "Enter demo mode" is now "Open the demo team" and goes to the computed stage: fixed in `634918f`. Beta still navigates to `/dashboard` (beta `SignInPage.tsx:191`).
- The setup guide's admin-flag fallback: fixed; arrival reads router state once and clears it (`apps/portal/src/routes/SetupPage.tsx:57-68`).
- The unnumbered "Link this machine" step: fixed; linking is step 4, and the unnumbered item is the conda precondition, which says why.
- The dashboard's silent branch fallback: fixed in `bf1c57d` (`apps/portal/src/routes/DashboardPage.tsx:657-662`).
- The 900 ms redirect after approving a device is still never cleared (`apps/portal/src/routes/ConnectionsPage.tsx:182`).
- `App.tsx` still writes `sessionStorage` during render (`apps/portal/src/App.tsx:69-77`). The claim that StrictMode swallows the notice is disproved for React 19.2.7.
- The Activity still stores the display name "Discord user", and it is now visible: the consent panel reads "Connect Discord user to Cog?" (`apps/portal/worker/routes/activity.ts:227`, `apps/portal/src/routes/ConnectionsPage.tsx:89`).
- The Activity still authorizes with `prompt: "none"` (`apps/portal/src/activity-main.tsx:226`).
- The "expires in 10 minutes" card is accurate for the link token; withdrawn. The one-hour session consequence is in B-69.
- The entry-point command still declares DM and user-install contexts the handler refuses (`apps/discord-bot/scripts/command-payloads.mjs:28-29`).
- **Severity:** `low`. **Decision needed:** `fix`.
- **Raised by:** most documents in the set, among them [`portal/sign-in.md`](portal/sign-in.md#open-questions-and-verification), [`portal/setup.md`](portal/setup.md#open-questions-and-verification), [`terminal/link.md`](terminal/link.md#open-questions-and-verification), [`discord/the-activity.md`](discord/the-activity.md#open-questions-and-verification)
- **Status:** narrowed; code read at `2ff32fa` bullet by bullet.

### B-63: The setup page calls a CLI report from the student's machine "Verified"

- **Where the user meets it:** The setup checklist and its completion panel.
- **What happens / what was expected:** "Verified" (a filled green mark, "seen by the portal", and "Everything the portal can verify checks out. Your terminal found the repository and called your code.") means `cogworks check` on a linked device reported the step. The glossary and the working brief say anything on a student's machine is never called verified. Expected: one definition.
- **Why (from the code):** `apps/portal/src/components/StepRail.tsx:34-48`; `apps/portal/src/routes/SetupPage.tsx:424-426`, `:456-462`; `apps/portal/worker/routes/setup.ts:110-111`.
- **Severity:** `low`. The claim is close to true; the word is the problem.
- **Decision needed:** `product call`. Narrow the definition to "observed by the portal, including reports from the CLI's own checks", or rename the tick.
- **Raised by:** [`foundations/what-the-portal-claims.md`](foundations/what-the-portal-claims.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta (beta `StepRail.tsx:27-35`).

### B-67: An official attempt does not say which synced weights it scored with

- **Where the user meets it:** A Week 3 official attempt promoted from a practice run that fetched synced weights.
- **What happens / what was expected:** The practice page says "{paths} from your local run at {sha}". The official job reuses that prepared environment, weights included, but carries no weight list, and the runner reports supplied weights only when it prepared the run itself, so the official page shows nothing. Expected: the run that can reach the leaderboard names the weights it scored with, for example copied from its parent.
- **Reproduce:** Sync weights, run practice at that commit, promote, compare the two pages.
- **Why (from the code):** `apps/portal/worker/execution/runner.ts:169`; `apps/runner-modal/src/cogworks_runner/modal_app.py:2222`, `:2295-2296`; `apps/portal/worker/routes/runner-events.ts:219-222`; `apps/portal/worker/db/schema.ts:393`; `apps/portal/src/routes/RunDetailPage.tsx:177-181`; the prepared record holds the weights at `prepared_environment.py:233-234`.
- **Severity:** `low`. The score is right; the page omits a disclosure.
- **Decision needed:** `fix`.
- **Raised by:** [`sandbox/prepare.md`](sandbox/prepare.md#open-questions-and-verification), [`cross-cutting/what-the-benchmark-supplied.md`](cross-cutting/what-the-benchmark-supplied.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Same on beta.
- **Status, re-read 2026-10-02:** by source, the claim above is wrong for a directly promoted attempt, and a Retry of a failed official attempt still drops the weights record. Neither has been observed. The reasoning above misses that promotion copies the practice run's row, `weightsSuppliedJson` included, into the official run (`apps/portal/worker/services/run-actions.ts:430`). A completed event without `weightsSupplied` leaves it as it is (`runner-events.ts:220-222`), so the official page should show the practice run's line. The defect narrows to Retry. A Retry successor is written field by field without `weightsSuppliedJson` (`run-actions.ts:618-642`). An official Retry reuses the prepared artifact, so the runner sends no list either, and a retried official attempt loses the line. Source is the same at `4984730`, `ed2b194` and `17d26d9` (`17d26d9` `run-actions.ts:614-638`). Read from code only. CROSS-15 or PREP-15 settles the direct promotion; the Retry case needs a failed official attempt retried.
- **Status, integrated `93dfa5e` source (2026-10-02):** a Retry that reuses the failed run's prepared artifact now carries its weights record (`505ce25`, `apps/portal/worker/services/run-actions.ts:621-648`). A Retry that prepares afresh starts empty and reports what it used. Covered by suite tests. The `17d26d9` checkpoint and the `f618038` full path did not exercise a promoted or retried run with synced weights; earlier receipts are as recorded above.

### B-69: Small behavior slips in the redesign

- An abandoned device or Discord approval keeps redirecting `/`, the wordmark and `/signin` to the dead approval form for the rest of the tab session, including after "The device code is invalid, expired, or already used." (`apps/portal/src/routes/Landing.tsx:30-31`, `apps/portal/src/routes/SignInPage.tsx:78-80`, `apps/portal/src/lib/pending-return.ts:9-19`; cleared only at `ConnectionsPage.tsx:72`, `:174` and `pending-return.ts:38`).
- After a failed official attempt, the pages say "Start a new practice run to create the next candidate to promote.", which names the path that counts if it completes and omits Retry, which costs nothing (`apps/portal/worker/services/run-eligibility.ts:115-117`; shown at `RunDetailPage.tsx:621-626`, `DashboardPage.tsx:506`, `:514`; Retry at `run-surfaces.ts:390-396`).
- The console and Discord offer promotion with no attempts left, then refuse with "The official-attempt quota is exhausted." (`apps/portal/worker/services/run-surfaces.ts:353-358`; `RunConsole.tsx:290-291`; `apps/discord-bot/src/commands.ts:560`; `run-actions.ts:420-422`). Status, `f03ebfa` (2026-10-03): the offer is unchanged; the refusal now reads "All 3 official attempts on this version are used. An official attempt that already succeeded may still be publishable; its run page says whether it is." (`run-actions.ts:128-129`, `:485`), and Discord shows it as written.
- An official run's rail marks Prepare and Install done by position and the page says "Every stage finished", though the run starts at the contract check (`apps/portal/src/components/PhaseRail.tsx:40-44`, `RunDetailPage.tsx:263-266`, `modal_app.py:2211-2214`). Fixture data runs every phase (`apps/portal/worker/execution/sync.ts:28`), so it cannot show this.
- The run page's promote control reads the active version's quota, not the run's; on an older version the server answers "That benchmark version is not active." (`apps/portal/src/routes/RunDetailPage.tsx:64`, `:70`; `apps/portal/worker/routes/dashboard.ts:37-47`; `run-actions.ts:158`, `:411`).
- An Activity whose socket drops after the one-hour session shows "Reconnecting…" forever, retrying every 8 s against a 401 (`apps/portal/worker/routes/activity.ts:19`, `:128-136`, `:280-281`; `apps/portal/src/lib/run-surface-stream.ts:57-62`).
- The quiet nudge counts hosted runs only, so a team running `cogworks run --live` daily is told publicly "The last run that scored for this team was N days ago." (`apps/portal/worker/services/team-nudges.ts:67-77`, `:125-135`).
- A synced weight that fails its size or digest check reads E-DATA "Benchmark data is not ready", with the file named only under Show details (`modal_app.py:1575-1576`, `failures.ts:41-50`, `apps/portal/src/components/FailureCard.tsx:65`, `:70`, `:139-143`). Rare, since admission checks the stored weight (`apps/portal/worker/execution/runner.ts:240-258`).
- The refusal card's command carries `--update-setup`, which does nothing when the check fails (B-16), and a not_read refusal prints a near-duplicate command above it (`apps/portal/src/components/RefusalCard.tsx:226`, `cli.py:1166`, `modal_app.py:731`).
- The Discord bubble lists the first four non-primary metrics in stored order with a gauge each, so a floor or a plotted rung can be drawn as a score (`apps/portal/worker/services/discord-messages.ts:164-172`, order from `run-surfaces.ts:176-179`).
- A crash in the CLI's own search is reported as "{benchmark} could not describe its task just now" (`python/cogbench/src/cogbench/cli.py:346-349`, `report.py:291-297`). Reachable only through a platform defect.
- **Severity:** `low`. **Decision needed:** `fix`.
- **Raised by:** [`portal/sign-in.md`](portal/sign-in.md#open-questions-and-verification), [`portal/promote-to-the-leaderboard.md`](portal/promote-to-the-leaderboard.md#open-questions-and-verification), [`foundations/the-run.md`](foundations/the-run.md#open-questions-and-verification), [`portal/watching-a-run.md`](portal/watching-a-run.md#open-questions-and-verification), [`discord/the-activity.md`](discord/the-activity.md#open-questions-and-verification), [`discord/channel-messages.md`](discord/channel-messages.md#open-questions-and-verification), [`sandbox/prepare.md`](sandbox/prepare.md#open-questions-and-verification), [`sandbox/discovery.md`](sandbox/discovery.md#open-questions-and-verification), [`sandbox/scoring-and-refusals.md`](sandbox/scoring-and-refusals.md#open-questions-and-verification), [`terminal/check.md`](terminal/check.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa`. Not checked on beta bullet by bullet; the server-side bullets are in files byte-identical there.

### B-70: Small copy slips in the redesign

- Server sentences use names the pages dropped: "They can also add you here from Team settings." (no page has that name), "Only the team creator can change team settings." (the page says Admin and allows several), and the admin console's "User not found." where the team page says the person must sign in once first (`apps/portal/worker/routes/team-membership.ts:69`, `:236`; `apps/portal/worker/routes/team.ts:149`; `apps/portal/worker/routes/admin.ts:386`).
- The console labels its first connection "Reconnecting…" (`apps/portal/src/lib/run-surface-stream.ts:21`, `:40`; `apps/portal/src/components/RunConsole.tsx:93-100`).
- The console's time column shows an em dash for an event with no elapsed time, which `docs/design/voice.md` bans (`RunConsole.tsx:115`).
- The run page and the Runs page title one run two ways, "Official attempt 1" against "Official attempt #1" and "on a detached commit" against "on commit {sha}" (`apps/portal/src/routes/RunDetailPage.tsx:296-306` against `apps/portal/src/lib/run-meta.ts:18-30`). Observed in local fixtures `pairs/b-dashboard-desk.png` and `pairs/b-run-official-desk.png`.
- A revoked GitHub sign-in prints its sentence twice in "Where the work went", the second ending in two full stops (`apps/portal/worker/services/process-signals.ts:125-126`, `:130-132`, `:550-552`; `apps/portal/src/components/ProcessPanel.tsx:237`).
- A could-not-look check names the unread module three times and prints "(ours)", though the docstring promises once (`python/cogbench/src/cogbench/verdict.py:318-326`, `:463`; `report.py:352`). Rendered locally with synthetic input.
- A failed local run prints a class name and a doubled full stop: "The run did not finish: PluginError: ... run this again.." (`python/cogbench/src/cogbench/cli.py:1202`, `isolate.py:386`). Observed locally on 2026-10-01.
- Setup step 4 says sync uploads any weight "that isn't already in your commit"; the CLI uploads every scored weight with no git check (`apps/portal/src/routes/SetupPage.tsx:236-237` against `cli.py:1305-1335`).
- **Severity:** `low`. **Decision needed:** `fix`.
- **Raised by:** [`portal/join-or-make-a-team.md`](portal/join-or-make-a-team.md#open-questions-and-verification), [`portal/the-team-page.md`](portal/the-team-page.md#open-questions-and-verification), [`portal/admin.md`](portal/admin.md#open-questions-and-verification), [`portal/watching-a-run.md`](portal/watching-a-run.md#open-questions-and-verification), [`cross-cutting/live-updates.md`](cross-cutting/live-updates.md#open-questions-and-verification), [`portal/the-run-page.md`](portal/the-run-page.md#open-questions-and-verification), [`terminal/check.md`](terminal/check.md#open-questions-and-verification), [`terminal/run.md`](terminal/run.md#open-questions-and-verification), [`terminal/sync.md`](terminal/sync.md#open-questions-and-verification)
- **Status:** open; code read at `2ff32fa` unless noted. Not checked on beta.

## Closed

### B-00: A successful GitHub sign-in leaves the student on the marketing page

Fixed in `d88a8cf`: the callback now returns to `/signin` (`apps/portal/worker/routes/github.ts:76`), which sends the student to a pending connection or the next stage (`apps/portal/src/routes/SignInPage.tsx:78-80`). On beta too. Not observed with real GitHub OAuth. Raised by [`portal/sign-in.md`](portal/sign-in.md#open-questions-and-verification).

### B-00a: A partial GitHub outage silently shortens the repository list

Fixed in `940c371`: a per-installation failure now throws (`apps/portal/worker/github/client.ts:209-214`) and reaches the 502 "GitHub did not answer the repository listing. Try again shortly." (`apps/portal/worker/routes/github.ts:114-131`), covered by `apps/portal/test/github-connect.test.ts`. On beta too. Not observed against a real multi-installation account. Raised by [`portal/connect-a-repository.md`](portal/connect-a-repository.md#open-questions-and-verification).

### B-01: Week 1 scores student code under a randomized hash seed, and the guard test cannot see it

Fixed in `0a554ba`: `week1_image` pins `PYTHONHASHSEED` (`apps/runner-modal/src/cogworks_runner/modal_app.py:446-455`), and the guard test selects all three images and asserts the seed in each (`apps/runner-modal/tests/test_prepare_rungs.py:207-223`). On beta too. Not observed; no repeated hosted Week 1 run has compared results. Raised by [`sandbox/prepare.md`](sandbox/prepare.md#open-questions-and-verification).

### B-05: `cogworks run --live` checks its preconditions after the ninety-second search

Fixed in `a63530b`: identity, link and repository are checked and the session opens before the project is copied and searched (`python/cogbench/src/cogbench/cli.py:1051-1060`, `:1175-1181`). On beta too. Not observed. Raised by [`terminal/run.md`](terminal/run.md#open-questions-and-verification).

### B-06: Changing the repository rewrites what every earlier run page claims

Fixed in `c6ab0a8`: run summaries and details take the repository from the run row (`apps/portal/worker/http/serializers.ts:114`). `f2e7776` adds a refusal for acting on a run from a repository the team left (`apps/portal/worker/services/run-source.ts:26-30`). On beta too. Not observed with a real repository swap. Raised by [`foundations/the-team-and-the-repository.md`](foundations/the-team-and-the-repository.md#open-questions-and-verification), [`portal/the-team-page.md`](portal/the-team-page.md#open-questions-and-verification).

### B-09: The weight upload has a fifteen-second timeout and a two-hundred-megabyte ceiling

Fixed in `70513b1`: the upload streams from a retained copy with a 60 s per-socket timeout, and client and portal both cap at 100 MiB (`python/cogbench/src/cogbench/client.py:158-212`, `packages/contracts/src/protocol.ts:149`); the largest corpus weight is 411 KB. No progress line was added. On beta too. Not observed. Raised by [`terminal/sync.md`](terminal/sync.md#open-questions-and-verification).

### B-09a: The Week 3 withheld sentence is cut off mid-word before the student reads it

Fixed in `8e6c470`: the cap is 600 characters with word-boundary splitting (`apps/runner-modal/src/cogworks_runner/modal_app.py:98`, `:156`; `packages/contracts/src/protocol.ts:174`), and week3 `94c7e64` writes one diagnostic per sentence. The cost is that the finding is now only "overall withheld: ... no image embedding to score." and the sync instruction is the third bullet. On beta too. Not observed on a real withheld run. Raised by [`sandbox/scoring-and-refusals.md`](sandbox/scoring-and-refusals.md#open-questions-and-verification).

### B-09c: The admin console counts quota differently from the quota

Fixed in `99281c5`: rows print "{n} practice runs · {n} official attempts" with no denominator (`apps/portal/src/routes/AdminPage.tsx:480-483`), covered by `apps/portal/test/admin-members.test.ts:311`. Local fixtures `pairs/a-admin-desk.png` and `pairs/b-admin-active-desk.png` show the rows; neither shows the two-benchmark case. On beta too. Raised by [`portal/admin.md`](portal/admin.md#open-questions-and-verification).

### B-10: `cogworks check` can exit 0 on a repository `cogworks run` refuses

Fixed in `666f29e`: both commands read one decision, `_scoreable` (`python/cogbench/src/cogbench/cli.py:389-447`), and an installed entry point is reported without counting as readiness, covered by `python/cogbench/tests/test_cli_readiness.py`. On beta too. Not observed. Raised by [`terminal/check.md`](terminal/check.md#open-questions-and-verification).

### B-20: The live run surface is unreachable from the portal and has no way out

Fixed in the candidate. The run page links in with "Open current run" (`b76723a`, `apps/portal/src/routes/RunDetailPage.tsx:104`, `:116-123`); the console links back to Runs in every state and to the run page on failure (`8e223d8`, `apps/portal/src/routes/RunSurfacePage.tsx:43-49`, `apps/portal/src/components/RunConsole.tsx:341-349`), and the Runs tab stays lit (`2fe2178`). Local fixture `pairs/b-run-surface-desk.png` shows the failed state only. Beta has the way in and only the header navigation out. Raised by [`portal/watching-a-run.md`](portal/watching-a-run.md#open-questions-and-verification).

### B-23: Promote is clickable while the quota is still loading

Fixed in `d88a8cf`: the button stays disabled until the quota arrives (`apps/portal/src/routes/RunDetailPage.tsx:655`). The remaining issue, that it reads the active version's quota, is in B-69. On beta too. Not observed. Raised by [`portal/promote-to-the-leaderboard.md`](portal/promote-to-the-leaderboard.md#open-questions-and-verification).

### B-36: Four user-facing strings use em dashes, which the voice guide bans

Fixed in `d88a8cf` and `208b6e0`: all four strings now use commas or two sentences (`apps/portal/src/routes/TeamPage.tsx:563`, `apps/portal/src/routes/RunDetailPage.tsx:647`, `apps/portal/worker/routes/team-membership.ts:236`, `apps/discord-bot/src/commands.ts:240`, `apps/discord-bot/src/index.ts:46`). The console's em dash for a missing elapsed time is in B-70. Beta's console still shows an em dash as the attempt number when none is left (beta `RunConsole.tsx:271`). Not observed. Raised by [`portal/the-team-page.md`](portal/the-team-page.md#open-questions-and-verification), [`portal/promote-to-the-leaderboard.md`](portal/promote-to-the-leaderboard.md#open-questions-and-verification), [`discord/commands.md`](discord/commands.md#open-questions-and-verification).

### B-39: Revoking a device and unlinking Discord have no confirmation

Fixed in `5194c82`: both are arm-then-confirm buttons, "Confirm, Cog stops seeing your team" and "Confirm, it stops reporting" (`apps/portal/src/routes/ConnectionsPage.tsx:258-264`, `:323-329`). Beta still fires on one press (beta `ConnectionsPage.tsx:228-233`, `:275-280`). Not observed. Raised by [`foundations/identity-and-roles.md`](foundations/identity-and-roles.md#open-questions-and-verification).

### B-40: The rail marks every stage done as soon as a result is published

Fixed in `02ed8c3`: each stage is read from its own run, and a stage that never ran is omitted (`packages/discord-kit/src/rails.ts:42-50`). Beta `26aa861` carries the same code. The unreachable `cancelled` divergence is B-37. Not observed. Raised by [`discord/channel-messages.md`](discord/channel-messages.md#open-questions-and-verification).

### B-42: A run with no overall score shows none of the evidence it does have

Fixed in `e76a75b`: the results block is gated on success alone, and with no primary the page says "This run has no overall score. Everything the scorer could measure is below." (`apps/portal/src/routes/RunDetailPage.tsx:236-247`, `:575-582`; orphan floors at `MetricBlock.tsx:396-413`). Confirmed at `49f6a98` with an injected record; not observed at `2ff32fa`. At the pinned week3 a withheld run always gets a substitute primary (`plugins.py:574-612`), so this branch needs a benchmark that names none. On beta too. Raised by the Astra lifecycle pass at `49f6a98` (SCORE-01/09) and [`sandbox/scoring-and-refusals.md`](sandbox/scoring-and-refusals.md#open-questions-and-verification).

### B-43: The back button restores a previous account's page

Fixed in `9dc76af`, `44c3ca6`, `f66aa7c`, `7f1944e` and `c00eb19`: `RestoreGate` (`apps/portal/src/components/RestoreGate.tsx`) conceals account-bound content when the page is hidden, rereads the session on return, and reloads the document when the login or team differs, covered by `apps/portal/test/restored-document.test.ts`. Confirmed twice at `49f6a98` (`history-before-back.jpg`, `history-repeat.jpg`); not re-observed at `2ff32fa` (SIGNIN-11, IDENTITY-01). The observation never showed old-account server access. On beta too. Raised by [`portal/sign-in.md`](portal/sign-in.md#open-questions-and-verification), [`portal/join-or-make-a-team.md`](portal/join-or-make-a-team.md#open-questions-and-verification).

### B-24: The refund cap is bypassed when Modal dispatch fails

Superseded by the recovery policy at `a0e8eac` (with `2bb0e92`): every failure uses no quota, and the refund cap and attempt ledger are gone (`apps/portal/worker/services/run-accounting.ts:11-13`, `apps/portal/worker/services/run-actions.ts:211-220`). Nothing to repair. Raised by [`cross-cutting/credit-and-quota.md`](cross-cutting/credit-and-quota.md#open-questions-and-verification).

## What was raised and is not here

Three classes of thing were left out on purpose.

**Unbuilt work.** `RunWorkflow` (`apps/portal/worker/orchestration/run-workflow.ts`) is a placeholder that nothing constructs, and the Cloudflare sandbox adapter (`apps/portal/worker/execution/sandbox.ts`) throws unconditionally. Both are deliberately unfinished and marked as such in the source.

**Things the documents could not determine.** They stay in each document's open questions. Four areas have no runtime evidence on either build: the Discord bot and Activity in a guild, a hosted Language execution, the current CLI against a portal, and instructor mutations such as adding staff, assigning TAs or deactivating a version. Entries in those areas rest on code reads; [`verification/README.md`](verification/README.md) tracks what each pass covered.

**Hardening observations with no user-visible symptom.** The unauthenticated device-start route, the unbounded token poll, the two-row team creation without a transaction, the missing unique index on a cohort join code, response validation being development-only, and the 426 that escapes the error envelope. Each belongs in a security or reliability review rather than in a list ordered by what a student meets first.
