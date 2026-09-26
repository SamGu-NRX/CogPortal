# Frozen polish acceptance

Accepted the focused correction at `255d2f43962c474eb057718d2a269eb8acde1841` against `8c5a2f42c0052b327cd0256944db3434bff77dc2`. No findings in the requested checks. Native Helium inspection used the existing development gallery and saved Worker/DB runs. This does not establish production or embedded Discord acceptance.

- `RunConsole.tsx:386-392`: all four lifecycle names remain visible and accessible at 360, 390, 639, 640, 768 and 1280px. Full layout switches from stacked to horizontal at 640px; compact stays stacked at every width. At 360px the compact lifecycle is 277px wide with no horizontal overflow. Published occupies one 12.5px text line. Full lifecycle is 303px wide. Fonts were loaded. The first entry in before-lifecycle-matrix.json was taken during viewport settling; before-lifecycle-360.json and the later viewport captures are the settled evidence.
- `FailureCard.tsx:75`: the reproduction command uses Shiki bash tokens and wraps. The existing saved failure `run_f16abe5a33` retains the exact command `cogworks check --benchmark language-search`. The new invalid-output gallery fixture copied exactly `cogworks test --benchmark audio-identification` by native click and Enter and announced Copied. Focus stayed on Copy command, then returned to Show details when collapsed; the collapsed command container is inert. An immediate first clipboard read lagged the Copied announcement; a separate settled read after mouse activation and the Enter read both matched exactly. Traceback remains plain text.
- `MetricBlock.tsx:13,104,221`: Hugeicons replace text triangles. The saved result `run_1d4ff86210` retains all 12 metric labels, values and direction claims, compared programmatically after removing the old triangle characters. Retrieval MRR has an up icon; Median rank has a down icon. Both are 10px aria-hidden SVGs with direction text retained. Unscored caption rows have no arrows. Gallery floor rows likewise have no arrows, and the recorded roles, withheld primary and legacy fixtures retain their prior direction claims.

## Matched native evidence

Before and after use the same fixture, state, viewport and existing browser styling. Dark Reader was already active and was left alone. Images are native captures, not reconstructed UI. The full viewport captures include surrounding gallery content; compare the named component. The new invalid-output fixture is after-only interaction evidence, not a before/after pair.

| Target | Before | After |
| --- | --- | --- |
| Full lifecycle, 360 × 900 | [Before](before-full-360-viewport.png) | [After](after-full-360-viewport.png) |
| Compact lifecycle, 360 × 900 | [Before](before-compact-360-viewport.png) | [After](after-compact-360-viewport.png) |
| Compact lifecycle, 768px viewport | [Before](before-compact-768.png) | [After](after-compact-768.png) |
| Saved failure expanded, 390 × 900 | [Before](before-failure-390-viewport.png) | [After](after-failure-390-viewport.png) |
| Saved result, 390 × 900 | [Before](before-result-390-viewport.png) | [After](after-result-390-viewport.png) |

Use these linked captures. Earlier 360px cropped images in this directory clipped component edges and are superseded by the viewport captures. Historical PR #20 media was not replaced.

Both isolated servers were stopped. Both application databases were restored from their exact baseline database files and their SQL dumps compared equal; each has zero login sessions. Temporary environment files, Vite configs and private optimizer caches were removed. Both source checkouts retain their exact frozen commits with no tracked changes; only the pre-existing dependency symlinks are untracked. Audit tabs were closed and the viewport override reset. The user's original demo tab and separate Helium window were untouched. No new runs, product-source changes or provider/account changes were made.
