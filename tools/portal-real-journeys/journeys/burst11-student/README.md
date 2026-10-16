# burst11-student — walk a new student's journey on alpha

A Playwright walker that takes one new student through the portal the way a
person would — sign in, join the cohort, start a team, link a real CLI device,
run a Week benchmark on their own machine, sync it, start practice runs, take
an official attempt, publish, and read the board signed out — and records a
verdict per step. This branch changes no product code; the walker and this
packet are the deliverable. It complements the real-journeys branch's staff
walk (#126 covers the TA desk / admin side; this covers the student side).

## Feature

`student-journey.mjs` drives one journey against a locally running dev stack
and prints a `VERDICT|step|state|note` line per step, plus full-page
screenshots at 1440×900 and 390×844 for every state. Environment knobs are env
vars (`PORTAL_URL`, `PYTHON_BIN`, `OUT_DIR`, `TEAM_NAME`, `STUDENT_NAME`,
`JOIN_CODE`, `WEEK1_EXAMPLE`, `DOUBLES_BASE`); the CLI plumbing (device link,
run, sync subprocess driving) is adapted from `journeys/cli.mjs` on the
real-journeys branch, and the provider doubles from that branch's stack are
reused for the no-outbound-traffic check when they are running.

`DOUBLES_BASE` (default `http://127.0.0.1:8811`) is where the github-rest
double answers; the discord and modal-runner doubles sit at base port +2 and
+3, and every journal URL is derived from the configured base rather than
hard-coded ports, so a doubles set on other ports is checked where it really
listens. Set `DOUBLES_BASE=off` to skip the no-outbound-traffic check
explicitly; a configured but unreachable double records a rough verdict
instead of ending the walk. The helpers in `journey-support.mjs` carry
regression tests: `node --test tools/portal-real-journeys/journeys/burst11-student/`.

Run it with the dev stack up (`pnpm dev` after `db:migrate:local` +
`db:seed:local`), a Python venv with cogbench and the week benchmarks
installed (`PYTHON_BIN`), and playwright resolvable.

## Evidence source

Walked on 2026-10-16 against alpha at `6554d59c` (this branch carries no
product change), on the local dev stack: Worker + local D1 migrated through
`0049`, `apps/portal/scripts/seed-local.sql` seeded, dev auth enabled,
execution provider `fixture` (GitHub client `FixtureGitHubClient`), and the
real-journeys provider doubles listening locally. The CLI ran in a Python
3.8.20 venv with cogbench and `benchmarks/week1` installed editable — the
environment a real student would have after the setup page's commands.

Raw evidence: ~30 screenshots at `/home/user/work/evidence/wave11-student/`
(desktop + mobile per state), verdict JSONs in `/tmp/wave11-verdicts*.json`,
driver logs in `/tmp/burst11-journey.log`.

## What works, how checked

Every verdict below is from the live walk, not from reading code.

- **Landing, sign-in, join** — works. The signed-out landing renders the
  example "What a run shows" card; dev sign-in (GitHub OAuth is unconfigured
  locally by design) lands the student on `/join`; join code accepted.
- **Start a team / pick a repository** — works. Team created on the fixture
  repository via `FixtureGitHubClient`. A real fork against the real GitHub
  client is not available locally; see What's left.
- **Device approval with a real CLI** — works. `cogworks link --portal
  http://localhost:5173 --no-browser` in the venv printed the approval URI and
  a confirmation code; the portal showed "Approve this device" with the same
  code; approving returned the CLI to its prompt with its Linked confirmation
  ("Linked … Local commands still work offline."), exit 0.
- **Setup checklist** — works. After the approval, a fresh load shows the
  Link-this-device step ticked ("Seen by the portal"). The first paint right
  after approving still showed 0 of 5 — the state arrives on the next load.
- **Local run + sync with a real CLI** — works. `cogworks test` and
  `cogworks run` on the Week 1 example (`audio-identification`, public data)
  produced report `local_1f7163bd…` with 11 metrics; `cogworks sync` filed it
  as `LOCAL RUN · SELF-REPORTED`, and the dashboard's Local reports panel
  shows the synced finding text and notes, labeled "Self-reported, not
  promotable".
- **Practice run (hosted, fixture runner)** — works. The practice run on
  `main` advanced Queued→Prepare→Install→Contract check→Evaluate→Score to
  Complete (~21 s simulated); the run page leads with "What this run shows"
  before the number (this scorer wrote no finding, so the page says so
  honestly rather than inventing one); the readings table renders floors and
  chance lines beside each measure.
- **Failed practice run** — works. The `missing-adapter` branch run fails at
  Contract check with the neutral "Nothing here could be scored" card, the
  `E-ADAPTER` category, a next step (`cogworks check --benchmark …`) that
  names where the code stopped, the raw log folded behind Show details, and
  the sidebar note that a failed run doesn't count against practice runs.
  This matches the real-journeys receipt `.github/review-media/pr-114/
  failure-card-after.png` (Run #743D, Oct 11) state-for-state on the live
  alpha (Run #640E, Oct 16); alpha additionally states "This run did not
  reach scoring" above the details toggle.
- **Promote to official** — works. The confirm dialog names the price
  ("uses attempt 1 of 3"); the official run succeeded on the fixture runner
  and the dashboard shows the attempt meter move to 1 of 3.
- **Publish** — works. The official run's console offers "Publish result";
  its confirm names the destination; the board then carries the entry.
- **Leaderboard** — works, with two rough edges (below). The published entry
  appears on its board tab with team description, provenance, the run's
  commit, and the primary measure; a signed-out visitor deep-linked to the
  same tab sees the entry and can open Details; mobile renders the same.
- **Sign out** — works. The account menu ("Account menu for …") opens a panel
  with Connections and Sign out; Sign out returns to `/signin` with no
  residue.
- **No outbound provider traffic** — works. The GitHub REST, Discord, and
  Modal doubles' request journals stayed empty across the whole journey:
  every provider call the walk triggered hit a local fixture or double.

Verdict scale: `works` / `rough` (ships, but a person will feel it) /
`broken`.

## Rough edges found (deliberately not fixed here)

1. **After publishing, the portal never points at the board tab that now has
   the entry.** The publish confirm says the destination ("Publish
   `<sha>` to the public leaderboard?") but nothing after the mutation links
   to the board, and the board defaults to its first module tab. Our student
   published on `language-search` while the default board is another module —
   walking there shows no trace of the entry they just published. A "See it
   on the board" link (or landing the student on their tab) is a design
   decision that belongs to the publish/leaderboard owner, not a break —
   recorded as the first follow-up.
   - Where: publish confirm at `apps/portal/src/components/RunConsole.tsx`
     (~line 313); board default-tab choice at
     `apps/portal/src/routes/LeaderboardPage.tsx` (~lines 90–113).
2. **The console's Published lifecycle tick only lights on the next snapshot
   fetch.** Immediately after the confirm closes, the lifecycle row still
   shows Published hollow; after a reload it reads complete. The publish
   mutation succeeds and the board already carries the entry — this is the
   in-place snapshot not being refreshed by the mutation.
   - Where: the run console lifecycle row and action refresh in
     `apps/portal/src/components/RunConsole.tsx`.

Both are above the break line (nothing misleads about a result), so this
validation packet records them instead of changing product files.

## Checks

- `pnpm check` — exit 0.
- `pnpm -r --if-present test` — exit 0 (portal suite included).
- `pnpm test:python` — the CogBench core suite passes on the system Python
  (1,281 tests, OK, run twice). The seven environment-dependent suites (modal
  runner, week 1–3 benchmark, week 1–3 submodule) need the benchmark
  submodules checked out and their packages — plus cogbench — installed into
  the runner's interpreter; a fresh checkout reports them "cannot run, because
  <package> is not importable here". After provisioning per the runner's own
  instructions and `benchmarks/week2`'s README, one full rerun gives: cogbench
  OK (1,281), modal runner OK (628), week 1 and week 3 benchmark suites OK,
  template catalog OK, week 1/2/3 submodule suites OK, and **week 2 benchmark
  2 failed / 182 passed / 5 skipped**. After the week2 README's documented
  `pip install -e benchmarks/week2/face_recognition_app`, its
  `test_reference_application_tracks_are_discoverable` passes and one test
  still fails:
  `tests/test_discovered_chain.py::TheirPipelineReadsAFolder::test_a_zero_argument_reader_is_handed_the_benchmarks_photos`
  (the candidate pipeline reads paths outside the directory the run owns, so
  the benchmark refuses it). Both failures reproduce on the untouched alpha
  tree — this branch has zero product commits — and are consistent with #125's
  disclosure that the root python suite carries pre-existing failures on the
  base branch; they are benchmark-side packaging/discovery tests, not portal
  student routes, so this packet records them and moves on.

## Rejected alternatives

- **Fix the two rough edges on this branch.** Both live in the publish →
  board → console flow whose design (what publish promises, where the student
  lands, when the lifecycle row refreshes) belongs to the portal's owners;
  changing it from a validation packet would decide a UX question nobody
  asked this walker to decide. Recorded with file:line instead.
- **Drive sign-out by role (`button`)** — the walker first looked for a
  "Sign out" button and missed it: the control is a link inside the account
  menu popover. The committed walker clicks the link by text.
- **Walk the leaderboard only via the default tab** (what the first run of
  the driver did) — that checked the wrong board and timed out. The committed
  walker reads the entry's own benchmark from the API and deep-links the way
  the publish flow should.

## What's left / not tested here

- GitHub OAuth sign-in, real repository forking via the real GitHub client,
  and the real Modal runner: the local stack is deliberately fixture-backed.
- The staff/TA desk, `/connections`, and the embedded Activity walk: covered
  by the staff-run packet (#126).
- The setup-checklist live-update tick lag this walk observed on first paint:
  fixed on the real-journeys branch by `a8aa493` (PR #102), which alpha does
  not carry; not re-fixed here.
- Sandbox-proofing of the student paths (expired device tokens, oversized
  logs, offline mid-run) — separate packet-sized work.
