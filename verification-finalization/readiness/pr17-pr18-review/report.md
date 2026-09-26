# PR17 and PR18 changed-journey acceptance

For the merge manager and existing portal owners. PR17's local Connections-to-CLI journey passes. PR18's Setup commands pass the exercised behavior, but its shared Code padding worsens the first-run dashboard at mobile width. Product source was not edited.

## Findings for the existing UI owner

- **P2: first-run dashboard overflow worsens at 390px.** With the identical three Language commands, prior `385bbda` overflows by 7px and PR18 `5a915da` by 35px. The pre grows from 315px to 343px, matching the new 28px right padding in `apps/portal/src/styles/app.css:222`. The first-run grid children at `apps/portal/src/routes/DashboardPage.tsx:441` do not shrink around the Code content. On PR18 the copy button spans x375–403 in a 390px viewport; the branch selector also extends past the panel. Preserve the existing composition and make its children fit. See `pr14-dashboard-390-before.png`, `pr18-dashboard-390.png`, and `pr18-dashboard-390-metrics.json`. Different fixture team names do not change the identical command text used for this comparison.
- **P3: the claimed 44px copy target computes to 42px.** PR18's 28px bordered button plus `::after { inset: -8px }` produces a 42px pseudo-element in Helium. `apps/portal/src/styles/app.css:119` claims 44px. The border reduces the containing area. This does not establish a minimum-target accessibility violation; it is a mismatch with the owner's stated acceptance value.
- **Remaining polish, source evidence only: clipboard rejection is silent.** `apps/portal/src/components/Code.tsx:81` and `CopyBlock.tsx:38` still ignore exceptions. Real success feedback and clipboard delivery were exercised; browser denial was not forced. Keep this separate from the confirmed overflow regression.

## Exact candidates and actual behavior

| Candidate | Head | Local origin |
| --- | --- | --- |
| PR17 | `39f6ae43bab401048743c9858e8920f734bd7dda` | `http://localhost:5198` |
| PR18 | `5a915dab1f81f460a21ae7e9e28fd28efd73d90b` | `http://localhost:5200` |

PR17 started with zero active devices and a nonexistent isolated COGBENCH_CONFIG. Helium copied the displayed `cogworks link --portal http://localhost:5198` exactly, by pointer and keyboard. The existing verifier CLI ran that command with `--no-browser` added solely to leave browser navigation to Helium. It printed the local approval URL and code. Approving the matching request under the disposable name `PR17 acceptance device` completed CLI polling, printed `Linked` and `setup: updated clone`, and returned the browser to Setup with the clone verified. The existing verifier clone and installed environment were reused; no installation or benchmark execution was required. The Setup hint also navigated to `/setup`. `pr17-connections-1120.png` captures the final-head empty state after revocation.

PR18's restored Setup rail rendered five Shiki blocks using the existing paper theme. Keyboard activation copied the entire 189-character pinned install command byte-for-byte and changed the button name to `Copied`. The signed terminal checkoff remained in CopyBlock; its copied command ran against localhost, exited 0, and changed the Language project from unchecked to checked off. The page updated from 2/5 to 3/5 done, retaining separate `Verified.` and `Checked off from your terminal.` states. This proves checkoff plumbing, not package installation.

At 390px all five readable Setup commands wrapped with equal client and scroll widths of 261px and zero page overflow. The prerequisite arrow rendered as a 12px SVG with aria-hidden; the dashboard arrow was 14px. Desktop and mobile screenshots are `pr18-setup-desktop.png` and `pr18-setup-390.png`. The first-run dashboard's multiline copy also matched its displayed text exactly, despite the layout finding above. A local synthetic failed-run detail copied `cogworks run --benchmark vision-recognition` through its new icon control and had zero mobile page overflow.

## Evidence limits and cleanup

These are separate candidate stacks, not a combined deployment. PR17 still has the older text Copy control because shared icon changes belong to PR18. Combined-candidate Connections copy acceptance remains due after integration. The existing owner reports establish original Code provenance; this pass verified its rendered behavior. No screen reader was driven. Landing and embedded Activity arrow call sites were not rendered here. The legacy failed-run detail does not exercise every RunConsole variant. Unchanged OAuth, hosted execution, source-action and broad UX flows retain their prior evidence and limits.

The known dashboard source CTA/local console attribution fixes and DroppedLinkNotice bare-command issue remain with their existing owners. They were not reimplemented or relabeled as new findings.

Only private verifier fixtures were changed. The synthetic failed-run row temporarily assigned to the PR18 fixture team was restored. The newly approved device was revoked through the UI, zero active devices were observed, and its isolated CLI config and signed checkoff command file were removed. `cleanup.json` records revoked device rows without credentials. Copied fixture setup evidence is retained as local test history. All three owned servers on 5196, 5198 and 5200 stopped; the temporary Helium tab closed and viewport override reset. No source edit, commit, push, deployment, remote run, Discord action or merge occurred.
