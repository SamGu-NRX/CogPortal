# Demo rehearsal and operator handoff

The production Audio and Discord delivery checks passed. Current results and limitations are in `production-0c90726/report.md`. The initial local checkpoint below is historical.

## Initial local checkpoint

- Local portal 9305d73ea808963212498b904b515ad2362f387f passed the generated install, device link, setup check, real Audio run with live sync, and saved-report sync. Root reports accepted 59e7373 differs by one test line only. Installed SDK d9405278aac8268cd340e589f36dbad766d1e2a0 and Audio b156644aecc810e0b93535e320098f96c39ae04e are verified in `identities.json`.
- The real Git edit, commit and push are complete. README-only commit e515ff619e02c16be903985d8536bc5ee6d7a2e9 is on SamGu-NRX/cogportal-demo-week1 branch `codex/demo-rehearsal-d9405278`. Local checkout was clean before scoring; remote SHA matches. Main remains at 71258046e60fecd3295c0b52236fc6e476b0e9cf.
- `check.txt` records five successful wiring checks and setup completion. The initial extra `--portal` argument was my invocation error, not a product defect; the exact generated command succeeded.
- `audio-report.json` records the fresh actual Audio score 0.5375 at e515ff6. Report local_80a1857827e344e79c344d00f8575bcb has 11 metrics and nine diagnostics. `persisted-proof.json` verifies exact metric and diagnostic equality after live delivery and saved sync, with one report row. Session localrun_e232ff1992084adeaf5fb07abf60ed68 succeeded and retained branch, repository ID 1356655835 and exact commit. No weights were supplied.
- `result-dashboard.png` and `result-dashboard.txt` show the local authenticated dashboard displaying e515ff6 and 0.5375 as self-reported. This is a private fixture team, explicitly labeled Local copy of browser-evidenced demo connection. It does not establish hosted execution or a Discord message; Discord identifiers are null.
- Earlier real browser login reached SamGu-NRX's CogPortal team and connected demo repository. `live-before.txt` records the old deployment, six previous hosted runs and four remaining practice attempts. Live Setup exposed SDK094a6f1a and the old Copy text. At that checkpoint, development promotion was pending. No new-schema request was sent to that old deployment, and no hosted attempt was consumed. Subsequent staging and production evidence supersedes this deployment state.
- The later compatible deployments, migrations and execution bindings were exercised in the staging and production reports. Accepted source contains highlighting, icon Copy controls and Hugeicons arrows. Remaining polish belongs to the existing UI owner.

The owned local result tab was closed. Sam's original Helium tab 1693192398 remains untouched in its separate window. The owned checkout, Python environment, linked local configuration and local Vite process are retained for continuation; cleanup is still pending. No product source changes were made in this checkpoint.


## Operator handoff for the live demo

Start at https://cogportal.sillion.app/setup in Helium. The current SamGu-NRX account already belongs to CogPortal, Setup is 5/5, the retained CLI is paired to production, and Discord SamG is linked to the team channel. This is a working rehearsal account, not a fresh onboarding screen. Keep that state intact.

The student checkout is `/Users/samgu/Programming Projects/CogPortal-rehearsal-student`, branch `codex/demo-rehearsal-d9405278`. Accepted commit `e515ff619e02c16be903985d8536bc5ee6d7a2e9` is already pushed. Inspect it before making a deliberate demo edit:

```sh
cd '/Users/samgu/Programming Projects/CogPortal-rehearsal-student'
git status --short --branch
git diff
git log -1 --oneline
```

After an intentional README demo edit, these commands stage only that file and push the rehearsal branch. The commit message is an example for that new edit, not a claim that another edit or commit is needed:

```sh
git add -- README.md
git diff --cached
git commit -m "docs: update demo walkthrough"
git push origin codex/demo-rehearsal-d9405278
```

For the retained working CLI environment, use:

```sh
source /tmp/cogportal-rehearsal-venv/bin/activate
export COGBENCH_CONFIG=/tmp/cogportal-rehearsal-state/config.json
export PYTHONDONTWRITEBYTECODE=1
export NUMBA_CACHE_DIR=/tmp/cogportal-rehearsal-caches/numba
export MPLCONFIGDIR=/tmp/cogportal-rehearsal-caches/matplotlib
cogworks check --benchmark audio-identification --update-setup
cogworks run --benchmark audio-identification
```

`run` scores locally. The explicit saved-report sync below was verified against production and reuses the existing actual report without scoring again:

```sh
cogworks sync '/Users/samgu/Programming Projects/CogPortal-rehearsal-student/.cogbench/reports/local_80a1857827e344e79c344d00f8575bcb.json' --portal https://cogportal.sillion.app
```

For a newly scored report, use the actual report path printed by that run. The website labels synced CLI results self-reported. A hosted evaluation is a separate action on https://cogportal.sillion.app/dashboard: choose the rehearsal branch and use Run practice benchmark. The final verified production quota is 2/10 practice used, eight left, and 0/3 official used. Do not use Promote to official for this walkthrough.

Saved hosted result: https://cogportal.sillion.app/runs/run_b647f110de. It scored 0.5375 in 2m18s and persisted after reload. Discord's new message in https://discord.com/channels/1515858059027550321/1515858059405295762 updated from progress to that result. Use the website for diagnostics and Discord for the concise update. The optional Activity still rejects app sign-in and is not part of the recommended demo.

For genuinely fresh onboarding, start at https://cogportal.sillion.app/signin with a participant's own GitHub account, the active cohort join code supplied privately by an instructor, and a repository that account can select through the GitHub app. The participant needs Git, the course Audio prerequisites and its environment, then the versioned install commands on Setup. Pair a fresh CLI with `cogworks link --portal https://cogportal.sillion.app` and approve it in that participant's browser. Discord linking is optional and starts with /cog in the course server. The existing rehearsal needs no new login, secret, repository, or setup reset. Because its prepared environment and config live under /tmp, keep them available through the demo; if the machine or cleanup removes them, follow Setup to rebuild and pair a new environment rather than inventing credentials.
