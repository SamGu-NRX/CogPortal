# PR21 native admin acceptance

For the root manager and PR21 reviewer. September 14, 2026. Accepted the two admin corrections within this local native Helium pass. No new defects found in the requested scope.

Before: public PR20 `dac24767b3b167dc25474be99f2a4f6af0f0260d`.
After: public PR21 `a668cf6aef816700da224d14ef52b548ef2118a8`.

- `apps/portal/src/routes/AdminPage.tsx:516-555`: all seven team identities and repositories have visible width in collapsed and expanded owner views at 360, 390, 639, 640 and 768px. The longest existing identity is Cosine Similarity Club with cogworks-demo/cosine-similarity-club. Existing truncation still applies where a repository exceeds available width; the full name remains in the accessible button text and the team name retains its title. Before, every identity column was zero at 360/390. After, minimum identity width is 231px at 360, 261px at 390, 510px at 639, 195.19px at 640 and 282.19px at 768. No horizontal document overflow occurred. Expanded TA/member inputs retain positive widths, including 147.66px for the TA field at 360.
- Desktop behavior is preserved. All seven row texts, including counts, match before/after at all six measured widths, including 1280. Computed grid columns match exactly at 640, 768 and 1280. At 639 and below, identity gets the first row and counts occupy following rows. See before-layout.json, after-layout.json and after-expanded-layout.json.
- Enter collapsed and reopened the focused team row. Focus remained on its named toggle with a solid 2px outline. Tab then reached Assign TA by GitHub login with a 2px outline. Expanded owner controls still show TA assignment, member entry and the same published score. The existing chevron rotation was retained; no separate animation timing claim is made.
- `AdminPage.tsx:70-71`: a staff role with no assignments sees TEAMS 0 and “No teams assigned to you yet.” The cohort still has seven teams. The same staff role with one TA assignment sees exactly that one team, its identity and member controls, with no owner roster/cohort panels or TA-assignment field. An empty owner cohort still shows TEAMS 0 and “No teams yet.”

## Matched native captures

All pairs use the exact public revisions above, the same private fixture data, viewport height 900, browser settings and page state. Dark Reader was already enabled and remains untouched. The phone list is taller after the repair because the names and repositories are now visible. Images are native browser captures.

| State | PR20 before | PR21 after |
| --- | --- | --- |
| Owner collapsed, 390px | [Before](before-admin-collapsed-390.png) | [After](after-admin-collapsed-390.png) |
| Owner expanded, 390px | [Before](before-admin-expanded-390.png) | [After](after-admin-expanded-390.png) |
| Owner collapsed, 768px | [Before](before-admin-collapsed-768.png) | [After](after-admin-collapsed-768.png) |
| Owner expanded, 768px | [Before](before-admin-expanded-768.png) | [After](after-admin-expanded-768.png) |
| Owner collapsed, 1280px | [Before](before-admin-collapsed-1280.png) | [After](after-admin-collapsed-1280.png) |
| Staff with no assignments, 390px | [Before](before-staff-empty-390.png) | [After](after-staff-empty-390.png) |
| Empty owner cohort, 390px | [Before](before-owner-empty-390.png) | [After](after-owner-empty-390.png) |

Additional scope evidence: [assigned staff at 360px](after-staff-assigned-360.png).

## Prior polish evidence and rendered PR

Source comparison confirms that FailureCard, MetricBlock and Code are identical to accepted255d2f4 after comments/whitespace are removed. RunConsole lifecycle markup is byte-identical. See polish-port-check.json. The earlier [polish report](../polish-255d2f4/report.md) therefore carries the highlighting, exact copy, direction-icon and lifecycle checks. Its images retain their original revision labels and must not be relabeled as public PR21. Other RunConsole refusal changes and gallery fixtures differ because those belong to separate combined work; this pass does not accept that ancestry.

Native inspection of draft PR21 confirmed the rendered title “fix(ui): keep run stages and team identity readable on phones”, explicit PR20 base dac2476, head a668cf6 and scoped verification text. It still says native acceptance and matched captures are pending. Root can replace that pending statement with this evidence. The earlier combined-candidate measurements and their separate revision are already labeled. No PR edits or posts were made. Rendered text is preserved in pr21-rendered-body.txt. Historical PR20 attachments were untouched.

## Fixture boundary and cleanup

Both public revisions were checked out in separate detached verifier worktrees. Both declare migrations through0041. Correction from the subsequent combined-candidate schema inspection: the restored private baseline is through0041, matching both public revisions. It does not include0042. No additional migration or product patch was added for this pass. Existing local recovery-local-owner signed in through the real development sign-in form. To exercise staff scope without external accounts, its private github_login temporarily became audit-staff-local, with a private roster row and one temporary TA assignment. An empty local cohort was temporarily inserted for the owner-empty state. These are simulated authorization/data fixtures, not GitHub authentication evidence. No benchmark run was created.

Both Vite servers stopped with exit130 after Ctrl-C. Both exact application database files were restored from their pre-pass backups and complete SQL dumps matched. Sessions, audit staff rows and the temporary empty cohort are all zero afterward. See cleanup.json for exact database paths and revisions. Temporary environment/config files, backups and private Vite caches were removed. Git status shows only dependency symlinks, no tracked edits. Audit tabs were closed and viewport override reset. Owner's staged-merge checkout, browser preferences and Sam's original separate demo window were untouched.

The full combined-candidate live/hosted rehearsal remains separate. This report does not establish deployment, real provider authorization or embedded Discord acceptance.
