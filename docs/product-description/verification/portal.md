# Verification: the portal

How to run this file: bring up the dev server and use a GitHub account that has never signed in to this portal, because half the claims here are about first-arrival state and an account that has already joined a team cannot see them again. Keep a second browser profile with a second account on the same cohort for the items marked `second account`, and a third that is listed in `PLATFORM_OWNER_LOGINS` for the admin items. Reset between passes by removing the account's cohort and team rows rather than by signing out; signing out does not undo a join.

`portal/the-team-page.md` describes work that was in flight during drafting. Re-read `apps/portal/src/routes/TeamPage.tsx`, `apps/portal/src/components/ProcessPanel.tsx`, and `apps/portal/worker/services/process-signals.ts` before running `TEAM-*`.

## portal/sign-in.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SIGNIN-01 | P1 | fresh account | Signing in lands the student on the next unfinished stage, not on the dashboard ([the ask](../portal/sign-in.md)). | Signed out, no cohort. | 1. Sign in with GitHub. | The browser lands on `/join`, not `/dashboard`. | not run |
| SIGNIN-02 | P1 | fresh account | A student sent to sign-in from a deeper route returns there afterwards ([Asking](../portal/sign-in.md)). | Signed out. | 1. Open `/setup` directly.<br>2. Complete sign-in. | After sign-in the browser goes back to where it was headed, not to the default stage. | not run |
| SIGNIN-03 | P2 | none | With GitHub unconfigured the button is disabled and says who to ask ([Answered without work](../portal/sign-in.md)). | A portal with no GitHub credentials. | 1. Open `/signin`. | The button is disabled and the page reads "GitHub sign-in isn't configured. Ask course staff to enable it." | not run |
| SIGNIN-04 | P2 | none | A cancelled GitHub authorization is distinguished from a failed one ([How it ends](../portal/sign-in.md)). | Any. | 1. Start sign-in and press Cancel on GitHub. | "GitHub sign-in was cancelled. Sign in again when you're ready." rather than the failure wording. | not run |
| SIGNIN-05 | P2 | none | A failed session read renders the signed-out page silently (suspected gap) ([Edge cases](../portal/sign-in.md)). | Block `/api/session` in devtools. | 1. Open `/`. | Record what happens. The document expects the signed-out landing page with no error. | not run |

Not checkable by hand:

- The demo-mode navigation defect, which is development-only and needs `DEV_AUTH=enabled` with GitHub unconfigured.

## portal/join-or-make-a-team.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| JOIN-01 | P1 | fresh account | A wrong join code names where to get the right one ([How it ends](../portal/join-or-make-a-team.md)). | Signed in, no cohort. | 1. Enter `ZZZZZZZZ` and press Join. | "That code doesn't match. Check the code your instructor shared." The field keeps its text. | not run |
| JOIN-02 | P1 | fresh account | A correct code lands on `/connect` ([How it ends](../portal/join-or-make-a-team.md)). | Same. | 1. Enter the cohort code. | The browser replaces to `/connect`. Pressing Back does not return to `/join`. | not run |
| JOIN-03 | P2 | fresh account | The field uppercases as you type and needs four characters ([While it works](../portal/join-or-make-a-team.md)). | Same. | 1. Type three lowercase characters. | The text shows uppercase; Join is not available until the fourth. | not run |
| JOIN-04 | P1 | second account | A cohort with no teams skips the choice screen ([Answered without work](../portal/join-or-make-a-team.md)). | A cohort where no team exists. | 1. Arrive at `/connect`. | The "Start a team" path is shown directly, with no Join-or-Start choice. | not run |
| JOIN-05 | P1 | second account | Joining a team whose repository you cannot push to names the person to ask ([How it ends](../portal/join-or-make-a-team.md)). | An existing team; this account has no GitHub access to its repository. | 1. Press Join on that team. | A sentence naming the team admin and telling the student to accept the GitHub invitation, then press Join again. | not run |
| JOIN-06 | P2 | second account | A failed teams query hides joining but keeps starting ([Answered without work](../portal/join-or-make-a-team.md)). | Block `/api/cohorts/teams`. | 1. Arrive at `/connect`. | The error card plus "We couldn't check the cohort's teams, so joining is hidden until this loads. Starting a team still works." | not run |
| JOIN-07 | P1 | second account | A student can be on exactly one team ([Interactions](../portal/join-or-make-a-team.md)). | An account already on a team. | 1. Try to join a second team. | "You are already on a team." | not run |

## portal/connect-a-repository.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CONNECT-01 | P1 | fresh account | Zero visible repositories gives three steps, not an apology ([Answered without work](../portal/connect-a-repository.md)). | An account whose GitHub app sees no repositories. | 1. Open the Start path. | "No repositories are visible yet. Three short steps:" followed by the fork steps. | not run |
| CONNECT-02 | P1 | fresh account | The submit label states what the click will do ([While it works](../portal/connect-a-repository.md)). | Repositories listed. | 1. Read the button before selecting.<br>2. Select an unclaimed repository.<br>3. Select one another team holds. | "Select a repository", then "Create team", then "Join {team}". | not run |
| CONNECT-03 | P1 | fresh account | A private repository is refused with the reason ([How it ends](../portal/connect-a-repository.md)). | A private repository selected. | 1. Press Create team. | "Repositories must be public to run the benchmark." | not run |
| CONNECT-04 | P1 | fresh account | Read-only access is refused with the reason ([How it ends](../portal/connect-a-repository.md)). | A public repository this account cannot push to. | 1. Press Create team. | "You need write access to run the benchmark for this repository." | not run |
| CONNECT-05 | P1 | fresh account | Success lands on the setup guide ([How it ends](../portal/connect-a-repository.md)). | A valid fork selected. | 1. Press Create team. | The browser replaces to `/setup` and the guide addresses the student as having created the team. | not run |
| CONNECT-06 | P2 | offline | A GitHub outage fails loudly rather than showing an empty list ([Cancel and interrupt](../portal/connect-a-repository.md)). | Make the GitHub listing fail. | 1. Open the Start path. | "GitHub did not answer the repository listing. Try again shortly." Not an empty repository list. | not run |
| CONNECT-07 | P3 | fresh account | The team name is prefilled from the repository and capped at 60 ([Asking](../portal/connect-a-repository.md)). | A repository selected. | 1. Read the field.<br>2. Paste 80 characters. | Prefilled with the repository name; the field stops at 60. | not run |

## portal/setup.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SETUP-01 | P1 | device | The guide verifies itself while the student works in the terminal ([While it works](../portal/setup.md)). | The setup page open, a linked device. | 1. Run `cogworks check --benchmark <id> --update-setup`.<br>2. Watch the page without reloading. | The matching steps flip to verified within a few seconds. | not run |
| SETUP-02 | P1 | none | The four chips say four different strengths of claim ([the trust chips](../portal/setup.md)). | Any partly complete guide. | 1. Read every chip on the page. | `portal verified`, `CLI checked`, `linked`, and `self checked` each appear on the step they belong to and are not used interchangeably. | not run |
| SETUP-03 | P1 | none | The track switcher rewrites every command on the page ([Modifiers](../portal/setup.md)). | Any. | 1. Note the benchmark id in each copy block.<br>2. Switch tracks. | Every block's benchmark id changes together. None is left on the old track. | not run |
| SETUP-04 | P1 | device | A command run in the wrong directory is refused by name ([How it ends](../portal/setup.md)). | A linked device, standing in a different repository. | 1. Run `cogworks check --benchmark <id> --update-setup`. | A sentence naming both this directory's repository and the team's. | not run |
| SETUP-05 | P2 | member | Arriving without router state changes the visible counter (suspected bug) ([Edge cases](../portal/setup.md)). | A student who joined a team while holding GitHub admin on its repository. | 1. Reach `/setup` from the Connect flow and note the counter.<br>2. Reach `/setup` from the user menu and note it again. | Record both. The document expects the count and the self-check to differ by how the page was reached. | not run |
| SETUP-06 | P2 | none | A completed unnumbered step still draws a tick (suspected slip) ([Edge cases](../portal/setup.md)). | A guide with the device linked. | 1. Count the ticks and read the header. | Record both. The document expects seven ticks under a header saying six. | not run |
| SETUP-07 | P3 | none | An incomplete guide does not nag ([How it ends](../portal/setup.md)). | Any incomplete guide. | 1. Read the footer. | "No rush. The guide keeps your place." | not run |

## portal/start-a-practice-run.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| START-01 | P1 | none | A second run is refused while one is active ([Answered without work](../portal/start-a-practice-run.md)). | One run in progress. | 1. Press "Run practice benchmark" again. | "A run is already in progress; runs go one at a time per benchmark." No second run appears. | not run |
| START-02 | P1 | none | An unpushed commit is refused by name ([Asking](../portal/start-a-practice-run.md)). | A local commit not pushed. | 1. Start a run on that branch. | A sentence naming the short SHA and telling the student to push it. | not run |
| START-03 | P1 | none | At ten of ten the controls disappear (suspected dead end) ([Modifiers](../portal/start-a-practice-run.md)). | A team with all practice runs used. | 1. Open the dashboard. | Record what is left. The document expects the branch select and run button to vanish entirely, leaving only the exhausted sentence. | not run |
| START-04 | P2 | none | A failed dispatch refunds and says so ([How it ends](../portal/start-a-practice-run.md)). | Make Modal dispatch fail. | 1. Start a run. | "The run could not be queued. Try again." and no attempt consumed. | not run |
| START-05 | P2 | none | The branch dropdown degrades silently when repositories fail to load (suspected bug) ([Edge cases](../portal/start-a-practice-run.md)). | Block `/api/github/repositories`. | 1. Open the dashboard. | Record what the branch control shows and whether any error appears. | not run |
| START-06 | P2 | none | An empty run log says what will appear there ([Answered without work](../portal/start-a-practice-run.md)). | A team with no runs. | 1. Read the run list. | "No runs yet. Your first practice run will appear here with its resolved commit and full diagnostics." | not run |

## portal/watching-a-run.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WATCH-01 | P1 | none | The run page updates itself and says how often ([While it works](../portal/watching-a-run.md)). | A practice run in progress. | 1. Open the run page and wait. | The phase advances without a reload, and the page says "Updates every 2 s." | not run |
| WATCH-02 | P1 | none | An official run suppresses its log and says so ([Modifiers](../portal/watching-a-run.md)). | An official run in progress. | 1. Open its run page. | "Hidden evaluation; logs are suppressed." and no log body. | not run |
| WATCH-03 | P1 | none | The evaluation counter does not move (suspected bug) ([While it works](../portal/watching-a-run.md)). | A run in its evaluating phase. | 1. Watch the counter for the whole phase. | Record every value seen. The document expects 0 of N throughout, then N of N. | not run |
| WATCH-04 | P1 | none | An official run's rail shows phases that never ran (suspected bug) ([Edge cases](../portal/watching-a-run.md)). | A promoted run reusing a prepared artifact. | 1. Read the phase rail. | Record whether Prepare and Install appear complete. | not run |
| WATCH-05 | P2 | discord | The live console reconnects after a dropped connection ([Cancel and interrupt](../portal/watching-a-run.md)). | A run surface open, a run in progress. | 1. Drop the network for ten seconds, then restore it. | The status chip reads "Reconnecting…" then returns to "Live", and no events are missing afterwards. | not run |
| WATCH-06 | P1 | none | The live console has no way out of its success state (suspected dead end) ([Edge cases](../portal/watching-a-run.md)). | A finished run surface. | 1. Look for any navigation on the page. | Record what is there. The document expects nothing but the browser's own Back. | not run |
| WATCH-07 | P2 | none | Another team's surface is a 404, not a forbidden ([Asking](../portal/watching-a-run.md)). | A surface id belonging to another team. | 1. Open it. | The not-found card, with no hint that the surface exists. | not run |

## portal/the-run-page.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RUNPAGE-01 | P1 | none | The page leads with what the run shows, not what it scored ([Summary](../portal/the-run-page.md)). | A succeeded run with diagnostics. | 1. Read the results section top to bottom. | The finding sentence appears above the primary metric, not below it. | not run |
| RUNPAGE-02 | P1 | week 3 | A withheld overall leads with the reason and never shows a zero ([the refusal](../portal/the-run-page.md)). | A Week 3 run whose image side did not bind. | 1. Read the finding and the metric list. | The withheld sentence leads. No `overall` row. No zero in place of the withheld scores. | not run |
| RUNPAGE-03 | P1 | week 3 | The withheld sentence is cut off (suspected bug) ([the refusal](../portal/the-run-page.md)). | Same. | 1. Read the finding sentence to its end. | Record the exact text. The document expects it to stop mid-word around 240 characters. | not run |
| RUNPAGE-04 | P1 | none | A floor is drawn without an arrow ([the metrics](../portal/the-run-page.md)). | A run whose benchmark publishes a floor. | 1. Find the floor. | It renders inline under the metric it belongs to, with no "higher is better" arrow. | not run |
| RUNPAGE-05 | P1 | week 3 | A withheld metric's floor disappears from the page (suspected bug) ([the metrics](../portal/the-run-page.md)). | A Week 3 withheld run. | 1. Look for `chance_mrr` and `search_chance`. | Record whether either is visible anywhere. | not run |
| RUNPAGE-06 | P1 | none | The wiring trace names the team's own functions ([the wiring trace](../portal/the-run-page.md)). | A run that bound a chain. | 1. Read the trace. | Headed "Your code, as it was run", each row naming `module.function` with what it took and returned. | not run |
| RUNPAGE-07 | P1 | none | A refusal is a card with a reason, not a failure message ([the refusal card](../portal/the-run-page.md)). | A run on a repository with nothing scoreable. | 1. Read the page. | A panel headed "WHAT THE BENCHMARK LOOKED FOR" with the headline and, when one is known, a next step. | not run |
| RUNPAGE-08 | P2 | none | The refusal headline appears twice (suspected slip) ([Edge cases](../portal/the-run-page.md)). | Same. | 1. Read the failure card and the refusal card together. | Record whether the same sentence appears in both. | not run |
| RUNPAGE-09 | P2 | none | A failure card says whether it cost an attempt ([the failure card](../portal/the-run-page.md)). | A failed official run. | 1. Read the card. | Either "This failure consumed one official attempt." or "No official attempt was consumed." | not run |
| RUNPAGE-10 | P2 | none | A practice failure never mentions cost (suspected gap) ([the failure card](../portal/the-run-page.md)). | A failed practice run. | 1. Read the card. | Record whether anything says the practice slot was used. | not run |
| RUNPAGE-11 | P2 | none | No diagnostics is said plainly ([Answered without work](../portal/the-run-page.md)). | A run whose scorer had no notes. | 1. Read the results section. | "The scorer had no notes on this run." | not run |
| RUNPAGE-12 | P3 | none | The log tails to fourteen lines with a toggle ([the log](../portal/the-run-page.md)). | A practice run with a long log. | 1. Count the visible lines and press the toggle. | Fourteen, then all, with the count named in the control. | not run |

## portal/promote-to-the-leaderboard.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PROMOTE-01 | P1 | none | Promotion states its cost before it happens ([Asking](../portal/promote-to-the-leaderboard.md)). | A succeeded practice run. | 1. Press "Promote to official" and read the confirmation. | The confirm label names which attempt of three this will be. | not run |
| PROMOTE-02 | P1 | none | Promote is clickable before the quota loads (suspected bug) ([Edge cases](../portal/promote-to-the-leaderboard.md)). | A run page opened cold on a throttled connection. | 1. Click promote as soon as it appears. | Record whether the click is accepted and what the server answers. | not run |
| PROMOTE-03 | P1 | none | Only a succeeded hosted run can be promoted ([Answered without work](../portal/promote-to-the-leaderboard.md)). | A failed run. | 1. Look for the promote control. | Absent, or refused with "Only a succeeded hosted run can be promoted." | not run |
| PROMOTE-04 | P1 | none | An exhausted official quota still allows publishing ([Modifiers](../portal/promote-to-the-leaderboard.md)). | A team with three attempts used and a succeeded official run. | 1. Open the run page. | "All official attempts are used for this benchmark version. Your existing successful official runs can still be selected for the leaderboard." and the publish control still works. | not run |
| PROMOTE-05 | P1 | none | Publishing states that it becomes public ([Asking](../portal/promote-to-the-leaderboard.md)). | A succeeded official run. | 1. Press publish and read the confirmation. | "Confirm, make this the public result" | not run |
| PROMOTE-06 | P2 | none | Promotion reuses the prepared artifact rather than rerunning ([The simple case](../portal/promote-to-the-leaderboard.md)). | A succeeded practice run. | 1. Promote it and watch the phases. | The official run starts at the contract check, with no prepare or install phase. | not run |
| PROMOTE-07 | P2 | none | A stale artifact is refused with what to do ([How it ends](../portal/promote-to-the-leaderboard.md)). | A practice run old enough that its artifact is gone. | 1. Promote it. | "The prepared hosted artifact is unavailable. Verify the commit again." | not run |
| PROMOTE-08 | P2 | none | The confirm label uses an em dash (suspected voice violation) ([Edge cases](../portal/promote-to-the-leaderboard.md)). | Any promotable run. | 1. Read the run page's confirm label and the dashboard's. | Record both. The document expects an em dash on the run page and a comma on the dashboard. | not run |

## portal/the-leaderboard.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BOARD-01 | P1 | none | The leaderboard is readable signed out ([Summary](../portal/the-leaderboard.md)). | Signed out. | 1. Open `/leaderboard`. | The page renders with standings, no redirect to sign-in. | not run |
| BOARD-02 | P1 | none | An inactive track's tab is still clickable (suspected bug) ([Modifiers](../portal/the-leaderboard.md)). | A cohort with an inactive track. | 1. Click the tab annotated "in progress". | Record what happens. The document expects the click to be accepted. | not run |
| BOARD-03 | P1 | none | Vision Overall fires its query even when no vision benchmark is active (suspected bug) ([Edge cases](../portal/the-leaderboard.md)). | A cohort with both vision benchmarks inactive. | 1. Open the Vision tab with the network panel recording. | Record whether `/api/leaderboard-family` is requested and what the page shows. | not run |
| BOARD-04 | P1 | none | An unreleased week's title is publicly visible (suspected bug) ([Edge cases](../portal/the-leaderboard.md)). | An inactive benchmark. | 1. Signed out, request `/api/benchmarks`. | Record whether the inactive benchmark's title and summary are present. | not run |
| BOARD-05 | P2 | none | A team appears in a family only when every component came from one commit ([Interactions](../portal/the-leaderboard.md)). | A team published on one vision benchmark only. | 1. Open Vision Overall. | That team is absent. | not run |
| BOARD-06 | P2 | none | Each row expands to its supporting evidence ([While it works](../portal/the-leaderboard.md)). | Any published entry. | 1. Click a row. | Supporting metrics, Commit, Completed, and a repository link. | not run |
| BOARD-07 | P2 | none | Empty says when to come back ([Answered without work](../portal/the-leaderboard.md)). | A benchmark with nothing published. | 1. Open it. | "No official results are published yet. Check again after teams publish their results." | not run |
| BOARD-08 | P3 | none | An open disclosure follows its row across a refetch (suspected slip) ([Edge cases](../portal/the-leaderboard.md)). | A board whose order can change. | 1. Expand a row and wait for a refetch that reorders it. | Record whether the open row is still the same team. | not run |

## portal/the-team-page.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TEAM-01 | P1 | member | A member sees the information and no controls ([Modifiers](../portal/the-team-page.md#modifiers)). | A non-creator member. | 1. Open `/team`. | No Rename, no Add member, no Remove, no Change repository, and no message explaining their absence. | not run |
| TEAM-02 | P1 | creator | Changing the repository states that history is kept ([How it ends](../portal/the-team-page.md#how-it-ends)). | Creator, a second eligible repository. | 1. Open Change repository and read the confirm label. | It names the consequence. Record the exact characters; the document expects an em dash the voice guide bans. | not run |
| TEAM-03 | P1 | creator | Changing the repository is refused while a run is active ([Cancel and interrupt](../portal/the-team-page.md#cancel-and-interrupt)). | A run in progress. | 1. Try to change the repository. | "Wait for the current run to finish before switching repositories." | not run |
| TEAM-04 | P1 | creator | The stage rail says who touched each stage and never how much ([the process panel](../portal/the-team-page.md#the-process-panel)). | A team with commits and at least one scored run. | 1. Read every row. | Names and avatars only. No counts, no percentages, no ordering by contribution. | not run |
| TEAM-05 | P1 | none | Before any run has scored, the panel says why there are no stages ([the process panel](../portal/the-team-page.md#the-process-panel)). | A team with commits and no scored run. | 1. Read the Stages section. | "Stages appear here after a run scores. The run is what tells the portal which week's pipeline to read your files against." | not run |
| TEAM-06 | P1 | member, creator | One member's bad GitHub token blanks the panel for everyone (suspected bug) ([the process panel](../portal/the-team-page.md#the-process-panel)). | A member whose GitHub token has expired. | 1. Have them open `/team`.<br>2. Within thirty minutes, have the creator open it. | Record what the creator sees. The document expects the fetch-failure sentence. | not run |
| TEAM-07 | P1 | creator | Co-author credit reaches the rail but not the churn list (suspected bug) ([Co-author credit](../portal/the-team-page.md#co-author-credit)). | A commit with a `Co-authored-by:` trailer naming a teammate. | 1. Find that commit in the contract-file changes list and find its stage in the rail. | Record which names appear in each. | not run |
| TEAM-08 | P1 | member | Nothing lets a member leave the team ([Edge cases](../portal/the-team-page.md#edge-cases)). | Any member. | 1. Search the whole product for a leave control. | None found, on any surface. | not run |
| TEAM-09 | P2 | creator | Removing a member arms and disarms itself ([While it works](../portal/the-team-page.md#while-it-works)). | A removable member. | 1. Click Remove once and wait five seconds without clicking again. | The label returns from "Confirm remove?" to "Remove" by itself. | not run |
| TEAM-10 | P2 | creator | A failed member change says only "Failed." (suspected gap) ([How it ends](../portal/the-team-page.md#how-it-ends)). | Block the member endpoint. | 1. Try to add a member. | Record the exact text shown beside the control. | not run |
| TEAM-11 | P3 | creator | Dates in the rail are UTC ([Edge cases](../portal/the-team-page.md#edge-cases)). | Any team with commits, in a non-UTC timezone. | 1. Compare a rail date with the same commit's date on GitHub. | The rail shows the UTC day, matching the finding sentence above it. | not run |

## portal/admin.md

| ID | P | Needs | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ADMIN-01 | P1 | owner | The quota numerators can exceed their own limit (suspected bug) ([Edge cases](../portal/admin.md)). | A team with runs on two benchmarks in the same week. | 1. Open `/admin` and read that team's usage. | Record both numbers. The document expects a total across benchmarks against a per-benchmark limit. | not run |
| ADMIN-02 | P1 | TA | A TA sees only assigned teams ([Modifiers](../portal/admin.md)). | An account assigned to one team. | 1. Open `/admin`. | The kicker reads "TA workspace", only the teams panel is present, and another team's id is refused with "This team is not assigned to you." | not run |
| ADMIN-03 | P1 | student | A non-staff visitor is redirected silently (suspected gap) ([Answered without work](../portal/admin.md)). | An ordinary student. | 1. Open `/admin`. | Record where they land and whether anything explains why. | not run |
| ADMIN-04 | P1 | owner | Rotating the join code states the consequence ([Asking](../portal/admin.md)). | Owner. | 1. Press Rotate join code. | "Confirm, the old code stops working" | not run |
| ADMIN-05 | P2 | owner | The join code is not cached ([Interactions](../portal/admin.md)). | Owner. | 1. Read the response headers for `/api/admin/overview`. | `Cache-Control: private, no-store`. | not run |
| ADMIN-06 | P2 | owner | A staff entry with no account says so ([Answered without work](../portal/admin.md)). | A staff login that has never signed in. | 1. Read the roster. | "not signed in yet" in place of a name. | not run |
| ADMIN-07 | P2 | owner | A team admin cannot be removed here ([How it ends](../portal/admin.md)). | Any team. | 1. Try to remove the creator. | "A team admin cannot be removed here. Change their permission on GitHub instead." | not run |
| ADMIN-08 | P3 | owner | The join-code alphabet avoids ambiguous characters ([Edge cases](../portal/admin.md)). | Owner. | 1. Rotate the code several times and read each. | No `I`, `O`, `0`, or `1`. Eight characters. | not run |

Not checkable by hand:

- Whether the `PATCH /admin/cohort` response should carry cache headers. That is a review question, not an observation.
- The parse-before-authorize ordering on two admin routes, which needs a crafted request rather than the UI.
