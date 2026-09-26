# CogPortal UX opportunities at 385bbda

The existing concise interface is the baseline. Keep its typography, paper-and-ink palette, setup rail, two-step confirmations, and finding-first result components. Four bounded outcomes would improve the connected experience. This is an independent UX audit of `385bbdab736015b180c16fd74ede493cab9f4367`, not visual acceptance of the whole product or another functional test cycle.

The manager and existing Opus owner are the readers. This report answers what to change next and why. No production code was edited. The highlighted-code/copy-icon work is already owned; do not duplicate it.

## Prioritized outcomes

### 1. P2: make the next action agree with the recorded source

- **Viewed in Helium:** an old-repository practice run appears as `Candidate ready` with an enabled `Promote to official` control on `/dashboard`. The same run's detail and shared console correctly replace that action with a source-change refusal. The run log names the old source, but the candidate card omits it. This makes the user discover eligibility by trying an action the server will refuse. No promotion was submitted in this audit.
- **Cause:** [DashboardPage.tsx:506](</Users/samgu/Programming Projects/CogPortal-verifier-actions-385bbda/apps/portal/src/routes/DashboardPage.tsx:506>) renders the candidate from its metric and disables the action only for quota; the data route selects the latest succeeded practice across repositories at `worker/routes/dashboard.ts:99`. Carry the existing server-derived eligibility and source into this card. Do not add a second source predicate in React or another action state machine. Keep old runs readable and label them as history.
- **A second instance, viewed:** a local-only completed console says `Repository: not recorded`, while its actual local session records ID `900001` and `fixture-org/repo-a`. The refusal correctly knows that source differs from the connected repository. `worker/services/run-surfaces.ts:327-330` derives the displayed source only from official/practice rows and ignores the local row. Use the source of the stage whose commit the console displays. Evidence includes the actual row, not merely a test title.
- **Related consistency:** the published-result dashboard card remains a commit and score without source. It does not explicitly claim the new repository produced that result, but adding the recorded source alongside the commit would remove the remaining ambiguity. Keep the existing selection intact.
- **Acceptance:** old/missing-source candidate cards name their source or honest unknown and give the same reason as detail; local-only console names its recorded repository; a same-ID rename remains ordinary history. Existing service guards remain the authority. Recheck these views, not the entire accepted PR14 test matrix.
- **Comparable evidence:** [dashboard at 1274px](dashboard-old-candidate-1274.png), [same run detail at 1274px](old-detail-1274.png), [dashboard at 390px](dashboard-old-candidate-390.png), [local console](local-console-1274.png), [recorded local row](local-source-row.json). The old run's timestamp was temporarily moved to make it the latest candidate; that field and the local source ID were restored afterward.

### 2. P2: finish the Connections-to-terminal handoff

- **Viewed:** `/connections` with no devices says `Run cogworks link` and offers no setup link or complete command in that panel. A first-time user may have no active portal. The CLI explicitly refuses that state at `python/cogbench/src/cogbench/cli.py:129-134` and tells them to obtain `cogworks link --portal ...` from Setup. Thus Connections sends the user to the terminal, which sends them back to find a different page.
- **Small fix at the owner:** [ConnectionsPage.tsx:241](</Users/samgu/Programming Projects/CogPortal-verifier-actions-385bbda/apps/portal/src/routes/ConnectionsPage.tsx:241>). Offer the existing origin-specific link command and a Setup link for users who have not installed the tool. Reuse the command rendering already being polished. No new onboarding wizard, configuration store, or auto-linking behavior.
- **Acceptance:** from an unconfigured CLI, the command copied from Connections reaches the correct portal's device request; the page explains what happens next. Use the already established local device fixture for the eventual check.
- **Evidence:** [Connections DOM](connections-desktop.txt), [page capture](connections-desktop.png). The empty device view was driven here; actual approval/revocation was not repeated. The prior exact-pin device journey remains separately recorded under `../actions-385bbda` and `../../ui-e8aed6e`.

### 3. P2 opportunity requiring a product decision: let instructor triage reach evidence

- **Viewed:** `/admin` names teams, run counts, and attempts. Expanding a team opens membership and TA controls plus a published-score footnote. It gives no run link or diagnostic drill-down. An instructor can see that a team has four runs but cannot use this page to inspect the run that needs attention.
- **Do not fix this by adding dead links:** opening another team's known run as the local owner returned the existing honest 404 view. `worker/routes/runs.ts:83-91` restricts detail to the viewer's own team. The UI cannot solve that access boundary alone.
- **Decision:** should the assigned TA/staff role read the team's run diagnostics? If yes, use the existing staff/assignment model to authorize the necessary read and add one contextual link from the team row to the most relevant run. Keep membership controls and the quiet summary. Do not create another instructor dashboard, personal grading metrics, or a general permission framework. If this view is meant only for roster administration, call it that and locate triage elsewhere explicitly.
- **Owner points:** `routes/AdminPage.tsx:665-673`, the team-row rendering above it, and the existing run-read gate. The original comment says the score belongs to the leaderboard and the row should help a TA choose which team to open; the missing destination prevents that intent from completing.
- **Evidence:** [expanded view at 1274px](admin-expanded-1274.png), [same view at 390px](admin-expanded-390.png), [expanded DOM](admin-expanded.txt), [other-team run response in browser](failed-run-access.txt). No staff assignment, member mutation, enrollment change, or join-code rotation was performed.

### 4. Existing owner outcome: carry shared finish through every command and action

- **Confirmed, already handed off:** Setup uses plain `CopyBlock`, while `Code.tsx` already supplies Shiki. Text COPY/OK controls and literal external-arrow characters remain across Setup, reproduction commands, and console actions. Use the existing concise components and tokens; finish their implementation rather than rebuilding the pages.
- **Include in the owner's acceptance coverage:** Setup and first-run commands, Connections link command, failure reproduction command, disclosure/log controls, source/SHA copy, and external actions. Preserve wrap for readable package pins and horizontal scrolling for opaque tokens. Icon-only controls need an accessible name, clear copied feedback, and an honest failure response. The current `CopyBlock` catch silently ignores clipboard failure, a source-only finding to handle in the active copy work.
- **Keep direction indicators meaningful:** metric arrows are not decoration. Preserve higher/lower semantics, benchmark-owned help, baseline relationships, and suppression where direction is unknown when changing glyphs. A literal triangle is not by itself a correctness defect.
- **References:** `components/CopyBlock.tsx:43-63`, `components/Code.tsx:28-53`, `routes/SetupPage.tsx:168`, `components/RunConsole.tsx:394`, and the previous [confirmed polish inventory](../actions-385bbda/missing-polish.json). No second implementation lane or cosmetic-change quota is proposed.

## What should stay

The design references describe an instrument beside the student's lab work, not a grading product. `docs/design/voice.md` asks for a concrete reason and next action, concise factual labels, and claims limited to what the portal observed. `the-instrument-not-the-judge.md` prioritizes findings and traces over a score. The observed failure page and the existing result gallery support that direction. Keep them.

- Home's four stages and Setup's five-step rail remain useful sequences. The previous pass verified `role=list`, compact check-offs, and live check-off persistence. Do not repeat or redesign them just to claim broader coverage.
- Sign-in explains an unavailable provider honestly. The join form keeps the entered code, announces a specific error, and lets the user correct it. The repository chooser turns an already-connected repository into a join action rather than creating a duplicate team. These states were viewed locally.
- Failure detail names the stage, gives a specific reason and next step, and offers a reproduction command. The copied seed failure has synthetic timing and literal backslash-n log text; those seed artifacts are not product findings.
- The log is keyboard-scrollable in this Helium version even though the `pre` has no explicit tabIndex. Tab reached it, focus had a solid outline, and Right changed scrollLeft. Do not add a fix based only on reading `tabIndex=-1`.
- Account-menu keyboard navigation reaches the next item and applies a visible background. The source returns focus to its trigger on Escape. The final Escape return was not separately captured, so no complete assistive-technology claim is made.

## Motion review

| Before, observed or source-read | After / disposition |
| --- | --- |
| `anim-rise` is 200ms; press response is 120ms; progress updates use transform. | Keep. These support state changes without delaying ordinary work. |
| Reduced-motion CSS removes entrance, live pulse, press transforms and progress animation; several Motion components read reduced-motion preference. | Keep. This was source-read, not a fresh OS reduced-motion test or frame-performance measurement. |
| LoadingMark names the pending read and adds elapsed seconds after three seconds, hidden from screen readers to avoid repeated announcements. | Keep. Do not introduce skeletons or more timeout machinery without a demonstrated waiting problem. |
| Completed console history collapses and the lifecycle remains visible, as described in the existing Discord handoff. | Reuse that layout. Do not fill its intentional empty space with decorative panels. Live Activity was not reopened. |

## Coverage and limits

| Area | Evidence in this audit | Uninspected or blocked |
| --- | --- | --- |
| Home / setup | Reused exact-candidate prior Helium captures and terminal check-off evidence. | No new installation, device approval or wiring check. |
| Dashboard / start controls | Viewed populated Audio, old-source candidate, branch control, source and quota cards; 1274/390 captures. | No new run started; active waiting behavior source-read and prior run evidence only. |
| Sign-in / cohort join | Viewed signed-out provider-unconfigured state on separate 127.0.0.1 local host; disposable local sign-in, invalid-code error and valid local cohort progression. | No real GitHub OAuth, cancellation, or OAuth recovery. Main localhost account unchanged. |
| Team/repository choice | Viewed both branches, existing repository selection and resulting join label. | Did not submit team creation/join; real repository inventory and GitHub permissions not tested. |
| Team settings | Viewed member/TA emptiness, repository editor and cancel, process signals. | No rename, membership, or repository write; picker had only its current fixture repository. |
| Connections / devices | Viewed empty GitHub/Discord/device state. | Approval, revocation and expired-code states not driven here. |
| Success/failure/logs | Viewed copied seed fixtures under disposable team, first-stage promotion confirmation only, local log keyboard scrolling. | No confirmation submitted; seed data is presentation evidence, not benchmark output. |
| Partial metrics / findings / traces | Viewed existing development gallery with findings, sweep curves, baselines, no-overall-score and unknown setup evidence. | Not a producer-to-page partial hosted run; specific RefusalCard composition source-read only. |
| Source-refused results / console | Viewed old-run refusal and local-only source omission. Reused prior exact-candidate unknown/hosted console evidence. | No rejected-action API matrix repeated. |
| Leaderboard | Viewed own Audio row expanded, source link, Language empty state. | No publication, refresh/reconnection test, or large-cohort density test. |
| Instructor | Viewed owner admin and expanded team, 1274/390; cross-team run read returned 404. | Assigned-TA/student role permutations and writes not driven. |
| Shared loading/error/success | Viewed join error, missing-run escape link, provider-disabled state; reused live check-off success; loading/error components source-read. | No network fault injection or latency measurement. |
| Keyboard / narrow | Viewed menu focus movement, log keyboard scroll, source dashboard, admin and failure layouts. Failure width 375 within 390px viewport. Prior setup narrow evidence reused. | No VoiceOver audit, touch hardware, full focus-order sweep, or measured contrast audit. |
| Discord entry / Activity | Current route/shared-component source and existing local/live reports reviewed. | `invalid_client` and the valid-secret question remain open. No repeat auth attempt, launch, message, or remote mutation. |

## Method and handoff

Used the existing product descriptions as a map, then current source and actual Helium pages as evidence. Those descriptions cite older commits and contain already-fixed findings; none was copied into this report without current support. Read the frontend-design, holistic-ux, web-animation-design and product-description skills and Sam's ten neo-slop complaints. The recommendations stay at existing owners, reuse stored facts, avoid overlapping flows, and add no framework, synchronization layer, blanket timeout, or production test hook.

Candidate ran from `/Users/samgu/Programming Projects/CogPortal-verifier-actions-385bbda` at localhost:5196. Added only clearly named local presentation rows and a separate disposable local identity. Restored the two temporarily changed fixture fields. Existing dirty checkouts and user-owned browser tabs were untouched. No external writes or deployment. Temporary viewport reset and local server stopped after the audit. Screenshots capture the current Helium appearance; no browser theme settings were changed.
