# PR14 source repair acceptance

No blocking finding in the requested changed journeys at immutable `7f981f4181fb572f2d3d0953f9a7bdba16663214`. Helium used the isolated verifier fixture at `http://localhost:5202`. These are local presentation fixtures and tests, not hosted evaluation or release acceptance.

- **Different and unknown source:** latest candidates remain visible as Previous result, with recorded source or “source not recorded,” a specific fresh-run explanation, and no promotion control. All six history rows remain. The dashboard does not silently substitute an older eligible result.
- **Same repository ID after rename:** the unpromoted scored candidate shows `cogworks-demo/previous-name`, while the connected source is `cogworks-demo/face-finder`. With both IDs equal to 1, Candidate ready and an enabled Promote to official return. No promotion was clicked. The original renamed fixture had already been promoted in an earlier test, so the existing unpromoted scored row was used for the isolated rename case.
- **Published result:** selection remains `run_source_official`, source `fixture-org/repo-a`, score 0.5375. It does not become the team's newly connected source or latest candidate. The entire selections table equals its baseline after inspection.
- **Local-only console:** recorded `fixture-org/repo-a`, commit and branch are visible, with the repository-change explanation ending “verify it here.” It no longer says the repository was not recorded. Hosted verification is absent.
- **Legacy mixed stages:** a local predecessor with null repository ID was attached only in this private fixture to eligible hosted and official stages. Both show the current stage's recorded source without inheriting the local refusal. Hosted offers Promote to official and Rerun hosted; official offers Publish result. No action was submitted.
- **Missing stage:** the local-only browser did not expose the invalid promote/rerun/publish actions. The existing exact-head test `test/run-actions.test.ts:762` exercised the shared mutation boundary in disposable in-memory databases: `not_promotable`, `not_found`, and `not_selectable`, with zero hub publications. This is test evidence, not a browser click or real publication.

All **46 focused tests passed**, none failed or skipped, across `run-actions.test.ts`, `run-source.test.ts` and `run-surfaces.test.ts`. `tests.log` includes the new dashboard, local-only, mixed-stage and missing-stage cases. An untracked fixture tsconfig resolves contracts to this exact worktree; no shared dependency or product source was changed.

## Comparable captures

The repaired different-source dashboard and local console were captured at 1274×900, matching the previous audit. Compare `dashboard-different-1274.png` and `local-console-1274.png` with `../ux-385bbda/dashboard-old-candidate-1274.png` and `../ux-385bbda/local-console-1274.png`. The previous dashboard offered invalid promotion; the repaired candidate explains the source difference. At 390×844 the repaired dashboard had zero horizontal overflow, captured in `dashboard-different-390.png`.

`dashboard-renamed-1274.png`, `legacy-local-hosted-1274.png`, and `legacy-local-official-1274.png` cover the eligible cases. Text receipts preserve the visible source and action labels. Synthetic phase durations and the inherited fixture metric label are not new hosted evidence.

## Cleanup and limits

Only the new private fixture copy was altered. Temporary timestamps, repository metadata and local-stage associations were restored. Reading one changed stage refreshed its local surface timestamp; that was restored after the owned server stopped. `cleanup.json` confirms all rows of runs, surfaces, local sessions and leaderboard selections exactly equal their baseline. Product git status contains only the private config files and existing dependency symlinks. No product edit, commit, remote mutation, promotion, publication, deployment or additional demo run occurred.

The local Helium tab closed and viewport override reset. Sam's deployed successful Audio result tab remains marked as a deliverable, untouched throughout this local check. PR18 mobile/copy repairs and DroppedLinkNotice were not retested here. Integrated release acceptance remains with the manager.
