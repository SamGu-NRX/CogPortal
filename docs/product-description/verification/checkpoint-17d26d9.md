# Checkpoint: local `17d26d9`, 2026-10-02

The feature documents describe `2ff32fa`. Since then the accepted beta `17d26d9` changed several behaviors that the documents and [`bug-triage.md`](../bug-triage.md) still describe as open. This page records what was actually observed on `17d26d9`. Readers can use it to tell a claim read from `2ff32fa` source apart from behavior seen on `17d26d9`. Results recorded against `4984730`, `ed2b194`, `2ff32fa` and `cbd8266` keep their labels. Nothing here marks a document `verified`.

## Conditions

- **Build:** Cog\*Portal `17d26d9`, served by the local development server. The portal frontend and worker source stayed at `17d26d9` throughout.
- **Execution provider:** fixture. Results are scripted and labelled Simulated. Nothing here was scored by a benchmark, and no hosted Modal run was involved.
- **Accounts and runs:** synthetic, created through development sign-in. Synthetic runs: practice `run_cd0f767a02` and the official attempt promoted from it, `run_50f1c9faec`, both on Language.
- **Browser:** Playwright 1.63 driving Chromium in fresh isolated contexts, with real clicks, typing and keyboard. Pages had real focus and visibility, with no patched events or visibility shims. Widths are stated per row.
- **Not covered:**
  - GitHub OAuth sign-in
  - Discord, `/cog` and the Activity
  - WebKit and physical phones
  - hosted scoring
  - a cold CLI install, and a scored `cogworks check`

## Observations

| What was done | What was observed | Bears on |
| --- | --- | --- |
| On `run_50f1c9faec`, only the `overall` metric row was removed, leaving its other readings. The lead reports restoring the row afterwards; the saved result does not record it. This imitates a partial Language result; no benchmark produced it. | Run page at 390 px: no Publish button, and the sentence "The leaderboard ranks teams by "overall", and this run didn't report it, so it can't be published. What it did report stays readable here." No horizontal overflow. | B-50 |
| Same run, publication requested through the API. | `409 not_selectable` with the same sentence. The lead reports the team's stored leaderboard selection was unchanged; the saved result records only the status and sentence. | B-50 |
| Same state, Language leaderboard opened signed out. | `200`, and the team's entry is absent. | B-50 |
| An owner adds a synthetic login on the staff roster through "Add staff". That login has no team and no TA assignment. | Add returned `200`. The roster note reads "Staff see only the teams assigned to them." The new staff member's `/admin` is the TA workspace with "No teams assigned to you yet." | B-66 |
| That staff member opens `/signin`, `/dashboard` and `/setup`. | Each settles on `/admin`. | B-48 |
| That staff member opens a pending device approval link on Connections. | Lands on `/admin` under "Your device link is on hold": "Linking a machine needs a team, and this account isn't on one, so the terminal will keep waiting until its code expires. Ctrl+C stops it." It adds that the console needs no team, and that to use the CLI they should join a team and run `cogworks link` again. Nothing was approved. | B-48 |
| That staff member requests a team's run. | `403`. | [admin](../portal/admin.md#three-roles): staff or TA status opens no team's run pages |
| A synthetic student runs the installed CLI's `cogworks link --no-browser` with an isolated config file, then approves the code on Connections. The CLI's own build was not recorded. | Approval `200`. The CLI exited 0, printed that it was linked, and gave the next step for a directory that is not a project. Connections then listed "CogWorks CLI, Linked …, not used yet" with Revoke. | [link](../terminal/link.md), [identity](../foundations/identity-and-roles.md) |
| Connections read before approval. | The device grant reads "It sends check results, synced local reports and runs you share live. It can't touch your repository, start a hosted run or publish a result." The Discord grant reads "Cog can start and retry hosted runs, spend official attempts and publish to the public leaderboard as you." | B-49, Connections half only |
| Revoke pressed, then Escape; then Revoke confirmed. | Escape left the device authorized. Confirming returned `200`, and the old device token then got `401`. The CLI's next command after revocation was not run. | [identity](../foundations/identity-and-roles.md#edge-cases), [link](../terminal/link.md#edge-cases) |

## What stays open

- **B-50:** this settles only the publication path. The Runs list heading and Discord's team best are changed in `17d26d9` source but were not observed. No benchmark-produced partial run has been seen.
- **B-48:** the account menu's wording for teamless staff was not observed. Neither was linking Discord from Connections while on no team.
- **B-49:** the Discord link confirmation panel and `/cog`'s own promote and publish controls were not exercised.
- **B-64:** read from `17d26d9` source and not repaired. A login still sits beside the score on the live console (`RunConsole.tsx:357`) and in Discord.
- **B-67 (weights line on an official attempt):** not observed. Promotion copies the practice run's row, weights record included, into the official attempt (`run-actions.ts:429-450` at `17d26d9`), so the earlier reading that the line is missing is in doubt.
