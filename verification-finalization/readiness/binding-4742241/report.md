# Admission correction at 4742241

The new-session correction passes the controlled local check. Acceptance against the real connected demo team and successful hosted dispatch remain pending authorized provider access and GitHub authentication.

- Actual installed SDK `1b7fc261abfe0ff006a4a678d936e75002e5bb39`, Audio `b156644aecc810e0b93535e320098f96c39ae04e`, and clean student commit `71258046e60fecd3295c0b52236fc6e476b0e9cf` completed one real Audio `--live` run, exit 0 in 35.87 seconds including startup, score 0.5375. The installed SDK reported `repository_id: null`. The controlled team used public repository ID 1356655835, not a verified copy of a currently connected team. See [identities](identities.json), [scope](scope.json), [run](actual-live-run.txt), and [report](actual-report.json).
- New session `localrun_3d0a04237ef748aa9b7112c12d92b69f` stored that fixture team's ID with the exact source name, full SHA and clean workspace. Native Helium offered **Verify hosted** after refresh. The normal SDK replay returned the same session and surface; count remained one. Wrong known ID and wrong repository name were rejected without changing the source. See [stored session](new-session.json), [replay and refusals](replay-and-refusals.json), and [refreshed browser](new-run-refreshed.txt).
- A separate, explicitly synthetic historical-null control retained null after replay and displayed the expected source refusal with no verification action. No existing historical record was altered. See [control scope](historical-null-control.json) and [browser refusal](historical-null-refusal.txt).
- Native **Verify hosted** reached confirmation, then refused the local development account with “Sign in to GitHub on Cog*Portal before changing a run.” No hosted row was inserted. Execution was configured only for the local fixture provider, with no Discord token or Modal URL. This proves action availability and the authentication boundary, not successful dispatch or hosted scoring. See [authentication boundary](verification-auth-boundary.txt) and [database proof](final-db-proof.json).
- Existing saved official fixture `run_8383cb703c` now uses “act on it” under Publish after its source stops matching the controlled team. See [Publish refusal](publish-refusal.txt).

## UI discussion for the existing owner

The original separate-window Helium tab remained at the signed-out deployed landing page. It showed no relevant Copy or metric controls; its build identity was not established. It was not navigated, reloaded or recreated.

Candidate failure reproduction uses an icon-only 13px Copy control and distinct Shiki colors. Setup/Gallery use separate `CopyBlock`, which has an icon-only control but plain, unhighlighted code. That highlighting gap was sent to the manager. Native metric arrows measured 11px primary and 10px supporting. Hugeicons means the library; no size defect was established. See [failure screenshot](failure-copy.png), [arrow measurements](metric-arrows.json), and [arrow screenshot](metric-arrows.png). No UI code was changed.

## Access and cleanup

The current remote D1 read failed with code 7403. No alternate account route was attempted after the manager declined one. Public GitHub identity alone does not establish a current team connection.

The local server stopped, verifier tab closed, temporary environment, student copy, credentials and caches were removed, and the application database was restored with exact SQL-dump equality. Local sessions returned to zero and Audio to inactive. The retained student checkout remains clean at 7125804; no tracked candidate changes remain. See [cleanup](cleanup.json).


## Missing responsive coverage at the same474 build

- **P2, account menu clipped at360px.** `apps/portal/src/components/UserMenu.tsx:166` anchors its208px popup with `right-0`. `Shell.tsx:47` permits the header to wrap. For an authenticated team member at360×900, the account trigger wraps to x20–74, so the menu opens at x−134–74 and most labels disappear. The document still has no horizontal overflow. [Native screenshot](responsive/account-menu-360.png), [settled item geometry](responsive/account-menu-360.json). At768px the same menu fits at x525–733. [Tablet comparison](responsive/account-menu-768.png). Sent to the existing UI owner through root.
- Tablet landing at768px and desktop populated dashboard at1280px fit. The shared skip link has a visible2px focus outline. Account-menu Down moves focus and Escape returns it to the trigger. Phone track menu at390px fits x20–308; Up moves to Recognition and Escape returns focus without changing tracks. [Landing](responsive/landing-768.png), [dashboard](responsive/dashboard-1280.png), [track geometry](responsive/track-menu-390.json).
- Desktop onboarding lists existing normal team names and descriptions. Space expands its remaining-team disclosure and focuses the newly revealed Join control; collapsing makes the region inert. Enter/Return did not activate in this tool session, while Space and native pointer did. The source is a standard button with an onClick; no new Enter product defect is established from this discrepancy. [Expanded desktop list](responsive/onboarding-expanded-1280.png).
- Attempting to join the existing Cosine Similarity Club fixture correctly shows a collaborator-permission alert at360px; its long text wraps within271px and the document fits345px. No credentials were substituted. Joining the supported existing Demo Team through its normal fixture flow succeeded. Dashboard inline promotion confirmation returned to its unarmed label without submission. [Permission alert](responsive/join-permission-360.png).

This pass added local onboarding/session records only, created no runs and did not repeat accepted admin team-row, run-result, failure-copy or lifecycle matrices. Existing admin acceptance remains in the PR21 report. No new authenticated production, reduced-motion preference, touch-device or actual hosted claim is made. The exact database baseline was restored, removing the temporary user/membership/session; server stopped, viewport reset, tab closed, and temporary config/cache removed. [Cleanup](responsive/cleanup.json).
