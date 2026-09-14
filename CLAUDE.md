# Cog\*Portal — working brief

You are working on a student-facing benchmark portal for MIT BWSI CogWorks. The UX skeleton is
sound; the ongoing work is design freshness and small-detail quality on every
surface. Look at everything yourself before changing it: run the app, click
through the flows, take screenshots. Send a subagent for architecture
archaeology and keep design judgment here.

## The bar (this is the owner talking)

- Every screen gets real design attention, including the easy ones. The
  first pass should already be thoughtful; polish is not a separate later
  phase.
- Read and apply the `frontend-design`, `web-animation-design`, and
  `holistic-ux` skills before UI work. Treat them as constraints.
- Fix small problems when you see them, even if nobody asked: a one-way
  door, an alarming default, a dead end, a link that should know the app is
  already installed, a disclosure that won't close again, a confirm that
  doesn't state its consequence.
- Prefer one decision per screen over a crowded page. When a page starts
  accumulating sections, reach for a wizard step, a fold, or a palette before
  more vertical space.
- Make the primary action one click. If the user must go somewhere (GitHub
  fork, install page), take them there with a real button, prefilled.
- Build interactive components in the house style rather than importing a
  themed library widget. New reusable components deserve the deepest design
  pass because they get copied everywhere.
- Never assume something works. Drive the real flow in the browser
  (`t3-code` preview tools when available, otherwise another preview) or
  with `curl` before calling it done. Typechecking alone is not evidence.

## What the platform is

Settled in `docs/design/the-instrument-not-the-judge.md`, which every surface
decision answers to. The short version: this is an instrument that reports
findings, not a judge that issues grades. The course's own evidence says so.
The instructor corrected a student who proposed a best-programming-group
contest, and privately counted Week 1 a success while calling the numbers
weak. `docs/vision/ideation-guideline.md` has the owner's direction verbatim
and `docs/vision/what-the-course-actually-taught.md` has the quotes with
timestamps.

Two rules that fall out of it and hold everywhere:

- **A run page leads with what the run shows, not what it scored.** The
  benchmark writes the sentence; the number sits below it. `Finding` and
  `SweepTrace` are that, and a new surface should compose them rather than
  open with a metric.
- **No per-person numbers, in any form, ever**, including private ones. A
  seventeen-year-old reads any per-person number as a grade regardless of the
  caveats. `python/cogbench/tests/test_process.py` fails the build on a field
  shaped like one.

## The theme

A scientific field notebook crossed with an evaluation instrument: warm
paper (`--color-paper #f7f3ea`), deep ink, detector red for attention and
consequence, verification green for observed trust, thin rules, near-sharp
corners, Source Serif 4 headings, IBM Plex Sans body, IBM Plex Mono for
anything that is data. The recurring geometric motif is the detection-box
corner bracket. Tokens and conventions live in
`apps/portal/src/styles/app.css`; compose with them, and new ideas are fine
when they fit the same notebook.

Two rules that outrank any color:

- **Trust language.** The portal only claims what it can verify. "Verified"
  means observed; anything on the student's machine is theirs to confirm.
  Never fake certainty in UI state or copy.
- **Voice.** All student-facing text follows `docs/design/voice.md`,
  distilled from the actual course materials (CogWeb + the 2025 notebooks).
  Read it before writing a single string. The standard is summarized below;
  the doc has source excerpts.

## How the writing sounds

Everyone who uses the portal reads the copy, so the words carry as much
design weight as the layout. The target is the course's own voice: an
instructor next to you at a lab bench. Human, grounded, some character,
never dramatic.

- Contractions are normal ("you'll", "it's", "doesn't"). Plain words over
  impressive ones. If a sentence sounds like marketing, rewrite it. Read
  drafts aloud against the excerpts in voice.md.
- "We" for shared explanation ("the repository is the team; we run every
  attempt from it"), "you/your" for the student's things ("your fork",
  "your first run"). "I" almost never.
- Give the why before the what, even for one-line instructions. The course
  never opens with a bare command or definition; a panel's first sentence
  should justify the panel.
- Opinions are fine when tied to a reason ("it is desirable for us to focus
  on NumPy rather than split our attention"). Never asserted for flourish.
- Be warm about the work, never about the user. The course delights in the
  material ("Isn't it beautiful?", a "Voila!" at a clean result); it never
  tells the student they're amazing. The portal can be fond of a run, a metric,
  or a clean fork; it does not compliment the person.
- Reassure with evidence or a checkpoint, as in "Past students did this with
  great success" or "If this is what you see, success!"
- When something is slow, optional, or destructive, say so in
  ordinary words. Don't hide difficulty and don't dramatize
  it.
- Prefer one medium sentence, then stop. If a second sentence adds no
  information, delete it. Errors: what happened, then one next action, like
  a TA who has seen this exact thing before.

Never do these (they read as AI, not as the course):

- Em dashes as a beat. Use commas, parentheses, semicolons, or two
  sentences. Banned in UI strings; the decorative `·` middot in mono
  metadata is fine.
- Tricolons ("fast, simple, powerful") and "not X, but Y" reversals.
- Dramatic one-word or fragment sentences.
- Marketing verbs ("unlock", "seamless", "supercharge", "effortless") and
  superlatives about ourselves.
- Cheerleading, emoji, urgency, FOMO.
- Exclamation points beyond a rare genuine checkpoint (about one per
  screen, in the course's "success!" register).

The trust-language rule rides on top: never claim more certainty than the
portal can observe.

## Engineering writing (docs, comments, commits, reports)

The rules above are for student-facing copy. Everything else (docs,
comments, commit messages, reports to the owner) is plain working prose.
Two failures keep recurring: documents written to show that work happened,
and invented terms used in place of explanations.

- Before creating a file, know who reads it and what question it answers.
  If there is no reader, don't create it. Don't restate the task, list what
  you did or didn't do, or repeat decisions already made in chat.
- Define an invented term in ordinary words the first time, or drop the
  term and say what the code does. "The compat layer translates path-based
  methods into contracts" tells the reader nothing.
- Explain like a good methods section: why it exists, what it does, how it
  works at a high level. Go lower only when the obvious approach was wrong,
  and then say what ruled it out.
- Delete sentences that add no information. Raise concerns as a short list
  with files and lines; concerns are wanted, essays are not.
- A changed default, constant, or behavior states its reason at the change
  site, backed by evidence that exists. Never write "calibrated" or
  "optimized" when no such run exists; if there is no evidence, say so and
  flag it.

## Instrument design defaults

These apply to the benchmark repos as much as the portal:

- Explicit beats guessed. Requiring a ten-line adapter from the student is
  fine; silently mis-mapping their method is not. An option is not worse
  just because it asks for explicitness.
- Components with one correct answer (cosine distance, descriptors) get
  strict isolated tests. Loose behavioral contracts are only for the parts
  where designs can legitimately differ.
- If the tool exists to reveal a quantity (a threshold, a rate), it
  measures and reports it. Don't make students hand-set the number the tool
  is supposed to find.
- CI runs what students run: Python 3.8, the pinned requirements.txt stack,
  conda env names from CogWeb.

## Motion instincts

Restrained and fast: ease-out entrances, ease-in-out for on-screen morphs,
under 300ms, origin-aware scale for popovers, no springs, blur only as a
2px perceptual bridge, everything gone under reduced motion (use
`useReducedMotion`; `MotionConfig reducedMotion="user"` is already set).
Never wrap the router `Outlet` in `AnimatePresence`. One well-placed reveal
beats scattered micro-animations. Constants live in
`apps/portal/src/lib/motion.ts`.

## Reuse before you build

Check `apps/portal/src/components/` first; most primitives exist and carry
the conventions: `Panel` (labeled instrument box), `Button`/`ConfirmButton`
(arm-then-confirm, consequence in the label), `Code` (Shiki, ink-on-paper
theme; use for a command a student is meant to read, whatever its line
count, and pass `wrap` when the tail matters), `CopyBlock` (a one-line
command to copy without reading, like a signed token),
`Veil` (collapsible progressive disclosure), `CornerBrackets`,
`MemberPalette` (anchored search palette; copy its popover/keyboard
patterns), `UserMenu` (canonical dropdown motion and focus behavior),
`QuotaCells`, `EmptyState`, `Feedback`. Accidentally duplicating one of
these is the most common mistake here.

## What we test for: platform reliability, not student cheating

The threat that matters here is not a student trying to beat the benchmark. It
is a student writing ordinary broken code on a Tuesday and taking something
down with it. Cheating costs one team's honesty; a crash costs every team the
afternoon, and it costs the instructors their credibility as the people running
the instrument. Write tests in that direction first.

The questions a change to the execution path has to answer:

- Does a broken adapter still produce a scored result or a categorized
  failure? It must never propagate out and kill the runner, the controller, or
  the scorer. Student code raising, returning the wrong shape, returning
  `None`, returning ragged lists, mutating our arrays in place, printing
  thousands of lines, or hanging are all ordinary, not exotic.
- Does the student learn what went wrong? A number near chance with no reason
  is the mystery box this course exists to avoid. The benchmark already writes
  good, specific notes ("embed_text returned an array with 1 dimensions;
  expected a 2-D (rows, D) matrix"); the job of the platform is to carry them
  all the way to the run page, not to compute and drop them.
- Do the stages and logs still reflect reality? A run that fails must not sit
  in `evaluating` forever, and the phase rail and log must describe what
  actually happened.
- Does one team's bad run affect anyone else? Shared caches, mutated case
  objects, and a wedged controller are the ways that happens.
- Does the leaderboard survive a partial or malformed result? It is public and
  unauthenticated; it must render for a signed-out visitor even when a run,
  a benchmark row, or a metric is missing.

Two failure modes we have actually hit, both worth a regression test rather
than a rule:

- Output the platform generates after student code runs (the showcase lines,
  final summaries) shared one byte budget with student output, and student
  output came first, so a chatty submission silently evicted ours. Anything
  appended late needs its own reserved room.
- Diagnostics were computed by the benchmark, sent by the runner, and dropped
  by the Worker, while `RunList` promised students "full diagnostics". Check
  that a value survives the whole path before promising it in copy.

When an instructor edits the benchmark submodule, the platform must fail loudly
rather than silently mis-score: the catalog row (`benchmarks` table), the
plugin's own metadata, and `scripts/validate_week*_submodule.py` all restate the
same versions on purpose, so a drifted edit breaks CI instead of a student's
result. Changing a metric or a contract is a new benchmark version, never an
in-place edit of a version teams have already published against.

## Hard-won correctness notes

- Route guards redirect on stale session data. After a mutation that changes
  session shape (joining/creating a team), TanStack per-call callbacks die if
  the component unmounts; see the suppression pattern in `ConnectPage` and
  the deliberately promise-returning `useInvalidateAll` in `lib/queries.ts`.
- Veiled/collapsed content needs `inert` + `aria-hidden`, and focus managed
  in both directions.
- One team per user is a DB invariant (unique index, migration 0011); the
  check-then-insert paths map violations to `already_on_team`.
- Setup check-off commands are Python one-liners on purpose: PowerShell
  aliases `curl`, but the course conda env guarantees `python` everywhere.
- Course facts (env names like `week2`, Python 3.8, bare `pip` vs our
  `python -m pip`) come from CogWeb prereqs; verify against
  `docs/design/student-cli-and-onboarding.md` before changing any command.

## Workflow

- **All three benchmarks are git submodules** pointing at their own GitHub
  repositories, so a change under `benchmarks/week{1,2,3}/` is committed
  there first, then the parent's pointer is bumped in a second commit. The
  Modal images bake the submodule contents, so `git submodule update --init`
  before deploying or the images carry whatever your tree happens to hold.
- Development-only `/__gallery` route holds the states that need a specific
  run to reach. Add a fixture there when a component has a state you cannot
  otherwise look at; it has already caught two layout bugs that typechecked.
- `pnpm check` at root typechecks all packages; portal-only via
  `pnpm --filter @cogworks/portal check`.
- `pnpm dev` serves on 5173 (applies local D1 migrations first). If every
  request 500s with a miniflare "fetch failed", the worker is wedged from
  stale HMR; restart the server.
- Dev auth: `POST /api/dev/login {"login":"anyname"}`. Local seed data:
  cohort join code and demo teams live in the D1 sqlite under
  `.wrangler/state/v3/d1/`; the fixture repo `cogworks-demo/face-finder` is
  joinable without GitHub access in dev. Clean up test users/memberships you
  create.
- New migrations: `apps/portal/migrations/NNNN_*.sql` + mirror in
  `worker/db/schema.ts` + `pnpm db:migrate:local`. The local D1 file lives
  under `apps/portal/.wrangler/`, not the repository root. A stale
  `.wrangler/` at the root also holds `.sqlite` files with the same table
  names and an older schema, so a query against it reports a migration as
  missing that in fact applied.
- Delegation: bounded backend and mechanical sweeps go to Codex/Sol with an
  explicit file whitelist, acceptance criteria, and a report shape; treat its
  output as untrusted until you re-run the checks and read the diff. If you
  edit files concurrently with a lane, expect the reviewer to mis-attribute
  your edits to it; verify by content, not by timestamps. Keep product,
  design, and copy decisions here.
- Do not commit, push, reset, or discard anything unless the owner asks; the
  tree usually carries parallel in-progress work.

## Known open threads

- **TODO(design):** Complete the visual pass for the connect wizard, member
  palette, and admin assignment rows.
- **TODO(release):** `cogworks-benchmark` 0.1.0 IS on TestPyPI and installs
  and runs (checked 2026-08-20 against the JSON API, then installed into a
  clean 3.11 venv). The stale claim here said it was never published, which
  would have sent someone to publish a published package.
  What is actually wrong is that 0.1.0 predates automatic discovery. Running
  `cogworks check` from it against a real repository prints nine lines of
  True and False and no next step; the same command in this tree reports
  which of the team's own functions it wired up. `pyproject.toml` is now
  0.2.0 and `publish-testpypi.yml` has to be dispatched by hand to close the
  gap. The install command in `SetupPage` is deliberately unpinned so a
  student picks up that release without a code change here.
- **TODO(media):** The GitHub org/fork walkthrough player is wired
  (`WalkthroughVideo`, gated by `GITHUB_TEAM_VIDEO` in `ConnectPage.tsx`);
  record the clip per `docs/runbooks/onboarding-media.md`, drop the four
  exports into `apps/portal/public/media/onboarding/`, and flip the constant.
- **TODO(design):** Give Landing, Leaderboard, and Connections a fresh
  design pass. Dashboard has been decluttered, but not reconsidered. Run
  Detail now leads with `Finding` and the sweep trace; the rest of it has
  not been reconsidered around them.
- **TODO(product):** The four process signals compute and test but reach no
  page. `docs/design/the-instrument-not-the-judge.md` names the TA triage
  console as the design for that page.
- **TODO(release):** Fork enforcement is off. Setting
  `GITHUB_TEMPLATE_REPO_ID` to `1339633157` turns it on, and doing so before
  every team has forked locks out the 2026 repositories, none of which
  descend from the template.
- **TODO(ops):** The template repository carries `ci/integration.yml` rather
  than `.github/workflows/`, because the publishing token lacks the
  `workflow` scope. A token with that scope could move it and delete the
  copy step from `ci/README.md`.
