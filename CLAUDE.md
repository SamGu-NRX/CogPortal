# Cog\*Portal — working brief

You are polishing a student-facing benchmark portal for MIT BWSI CogWorks.
The UX skeleton is sound; the ongoing work is design freshness and small-detail
quality across every surface. Look at everything yourself before changing
anything: run the app, click through the flows, take screenshots. Send a
subagent for architecture archaeology; keep design judgment here.

## The bar (this is the owner talking)

- Every surface gets real design attention, including "easy" functionality.
  There is no screen too minor to deserve taste. First pass should already be
  thoughtful; polish is not a later phase.
- Before UI work, read and apply the `frontend-design`,
  `web-animation-design`, and `holistic-ux` skills. Treat them as design
  constraints, not optional polish.
- Small details are the product: a link whose text knows the app is already
  installed, a disclosure you can close again, a confirm that states its
  consequence. When you see a one-way door, an alarming default, or a dead
  end, fix it even if nobody asked.
- Prefer one decision per screen over a crowded page. When a page starts
  accumulating sections, reach for a wizard step, a fold, or a palette before
  reaching for more vertical space.
- Make the primary action one click. If the user must go somewhere (GitHub
  fork, install page), take them there with a real button, prefilled.
- Custom-build interactive components in the house style rather than
  importing a themed library widget. New reusable components deserve the
  deepest design pass of all; they get copied everywhere.
- Never trust that something works. Drive the real flow in the browser
  (`t3-code` preview tools when available, otherwise another browser preview)
  or with `curl` before calling it done. Typechecking is the floor, not the
  finish.

## The theme, held loosely

The identity is a scientific field notebook crossed with an evaluation
instrument: warm paper (`--color-paper #f7f3ea`), deep ink, detector red for
attention and consequence, verification green for observed trust, thin rules,
near-sharp corners, Source Serif 4 headings, IBM Plex Sans body, IBM Plex
Mono for anything that is data. The one recurring geometric motif is the
detection-box corner bracket ("the instrument is looking here"). Tokens and
conventions live in `apps/portal/src/styles/app.css`; treat them as the
palette you compose with, not a cage. New ideas are welcome when they feel
like they belong in the same notebook.

Two deeper commitments than any color:

- **Trust language.** The portal only claims what it can verify. "Verified"
  means observed; everything on the student's machine is theirs to confirm.
  Never fake certainty in UI state or copy.
- **Voice.** All student-facing text follows `docs/design/voice.md`, which
  was distilled from the actual course materials (CogWeb + the 2025
  notebooks). Read it before writing a single string. The full standard is
  below; the doc has representative source excerpts if you want to hear the
  real thing.

## How the writing actually sounds

The copy is the interface. Everyone who uses this portal reads it, so the
words carry as much design weight as the layout. The target is the voice of
the CogWorks course itself: an instructor standing next to you at a lab
bench. Human, grounded, a little bit of character, never dramatic for show.

Write like the course authors do. What that means concretely:

- **A person, not a product.** Contractions are normal ("you'll", "it's",
  "doesn't"). Plain words over impressive ones. If a sentence sounds like
  marketing, it's wrong. Read every draft aloud; if the course excerpt in
  voice.md sounds like a human and your draft sounds like a landing page,
  rewrite the draft.
- **We and you.** "We" for shared explanation ("the repository is the team;
  we run every attempt from it"), "you/your" for the student's own things
  ("your fork", "your first run"). "I" almost never.
- **Say why before what.** Even a one-line instruction earns a half-clause of
  motivation. The course never opens with a bare command or a bare
  definition. A panel's first sentence should justify the panel.
- **Opinionated, but grounded in a reason.** The authors have taste and show
  it ("it is desirable for us to focus on NumPy rather than split our
  attention"), but the opinion is always tied to a why, never asserted for
  flourish. Have a point of view; earn it.
- **Warm about the work, never flattering the user.** The course gets
  genuinely delighted by the material ("Isn't it beautiful?", an adorable
  dataset, a "Voila!" at a clean result). It never tells the student they're
  amazing. The portal can be fond of a run, a metric, a clean fork; it does
  not compliment the person.
- **Reassure with evidence or a checkpoint, not cheerleading.** "Past
  students did this with great success" and "If this is what you see,
  success!" are the models. "You've got this!" is not.
- **Honest about hard things, plainly.** When something is messy, slow,
  optional, or destructive, say so in ordinary words ("this is a real mess",
  "this is totally optional", "history stays with the team"). Don't hide
  difficulty and don't dramatize it.
- **Short. Then stop.** This is an instrument panel, not an essay. Prefer one
  medium sentence. If a second sentence carries no new information, delete it
  rather than polish it. Errors especially: what happened, then one next
  action, in the voice of a TA who has seen this exact thing before.

Never do these (they are the tells that break the voice):

- Em dashes as a beat. Use commas, parentheses, semicolons, or two sentences.
  (This is the most common AI-slop signature; it is banned in UI strings.
  Keep the decorative `·` middot in mono metadata; that's fine.)
- Tricolons ("fast, simple, powerful"), and "not X, but Y" reversals.
- Dramatic one-word or fragment sentences for effect.
- Marketing verbs ("unlock", "seamless", "supercharge", "effortless") and
  superlatives about ourselves.
- Cheerleading, emoji, urgency, FOMO.
- Exclamation points beyond the rare genuine checkpoint (roughly one on
  screen at a time, in the course's own "success!" register).

And the trust-language rule above rides on top of all of this: never write
copy that claims more certainty than the portal can observe.

## Motion instincts

Restrained and fast: ease-out entrances, ease-in-out for on-screen morphs,
under 300ms, origin-aware scale for popovers, no springs, blur only as a
2px perceptual bridge, everything gone under reduced motion (use
`useReducedMotion`, `MotionConfig reducedMotion="user"` is already set).
Never wrap the router `Outlet` in `AnimatePresence`. One well-placed reveal
beats scattered micro-animations. Constants live in
`apps/portal/src/lib/motion.ts`.

## Reuse before you build

Check `apps/portal/src/components/` first; most primitives exist and carry
the conventions: `Panel` (labeled instrument box), `Button`/`ConfirmButton`
(arm-then-confirm, consequence in the label), `Code` (Shiki, ink-on-paper
theme; use for any multi-line command), `CopyBlock` (single command),
`Veil` (collapsible progressive disclosure; real content peeking under
tracing paper), `CornerBrackets`, `MemberPalette` (anchored search palette;
copy its popover/keyboard patterns), `UserMenu` (canonical dropdown motion
and focus behavior), `QuotaCells`, `EmptyState`, `Feedback`. Duplicating one
of these by accident is the most common self-inflicted wound here.

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
  `worker/db/schema.ts` + `pnpm db:migrate:local`.
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
- **TODO(release):** `SetupPage` environment commands assume the published PyPI packages
  (`cogworks-benchmark`, `cogworks-vision-benchmark`); if those aren't live
  when students arrive, swap that one constant to the monorepo-relative
  install.
- **TODO(accessibility):** Make the setup guide's optional device step
  semantically unnumbered; screen readers currently count it.
- **TODO(design):** Give Landing, Leaderboard, Run Detail, and Connections a
  fresh design pass. Dashboard has been decluttered, but not reconsidered.
