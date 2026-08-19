# The platform is an instrument, not a judge

**Status:** design direction, 2026-08-19. Resolves the tension named in
`docs/vision/ideation-guideline.md` and answers to it.

## The problem this solves

We built a scoreboard for a course that does not believe in scoreboards.

The evidence is not ambiguous. The instructor corrected a student who proposed
a best-programming-group contest, in the moment: "the goal for this is not to
like show up anyone in your team. The goal here is to have a team that works
effectively right?" He closed Week 1 publicly by saying teams went "from
unfamiliar territory to actually building something that kind of works," and
privately told the TAs that "the results are probably sketch. I don't think
there was enough rigor there, but nevertheless, the fact that they got as far
enough to make something and test it... I'm pretty impressed." He named the
numbers as weak and counted the week a success anyway, on process grounds, in
a room with no students in it.

And the owner is explicit: "You shouldn't think about the benchmark for the
students as something to optimize for, where the bigger number means better."

## The resolution

We did not build a judge. We built a **sensor**, and the remaining work is
making the display honest about what a sensor is.

This is not a reframing for its own sake. The course's own taught method is a
sweep: "start easy and then start growing the library and see how your
performance degrades." A run page that shows one number for one configuration
does not support the method the students were taught. A run page that shows
the degradation curve **is** the method.

That single change resolves the tension, because a curve cannot be ranked the
way a number can. Two teams with the same top score have visibly different
curves, so the surface itself argues against convergence onto our test set,
which is exactly what the owner asks for.

## What a run page shows, in order of visual weight

1. **The finding.** One sentence, largest type. Assembled from a template,
   never generated, so trust language holds: "Identification holds to a
   120-song library, then falls off. The mismatch shows up in the query
   stage." Or for a failed run, the specific contract violation. A sentence
   can name a stage and a cause; a number cannot.
2. **The trace.** Score against the difficulty knob, this run in ink, the
   team's previous run ghosted behind it. The knee annotated. This is the
   emotional center of the page and it differs for every team.
3. **The stage rail.** The capstone's named stages left to right, each with
   what was observed and its diagnostic note. This is where `metric_help`
   already lives; the work is carrying it to the page.
4. **Coverage.** What this run exercised: save/load, deletion, duplicate
   guarding. Framed as what the instrument saw, never as a to-do list. This
   is how "optional" stops meaning "worthless."
5. **The metric grid, as a footnote.** Mono, small, with the delta against
   the team's own previous run. No rank, no other teams. The number is on the
   page because hiding it would be coy; it is typographically a footnote, the
   way a raw voltage reading sits under a plotted trace.

## The process layer

The owner names the real failure: students "struggled with understanding
beyond the individual level, since some people do a lot of the work." No
leaderboard fixes that. Four signals do, and each survives a trap we already
measured:

- **Stage footprint.** Attribute each commit to a capstone stage by the files
  it touches. Says whether the week's work spread across the pipeline or
  piled onto one stage. Indifferent to line counts, so committed binaries and
  a 400-line deletion both read correctly.
- **First light.** The first run that executes end to end, and the count
  since. This is the integration instrument, and integration is what the
  instructor called "the most important part at the end." A Wednesday nudge
  to a team with no end-to-end run is the single feature most likely to
  change an outcome.
- **Boundary churn.** A signature change to a contract function after first
  light is a breaking event worth naming. Before first light it is ordinary
  design work.
- **Stage ownership breadth.** How many distinct people have touched each
  stage. A bus-factor map, not a leaderboard.

Two rules hold absolutely. **No per-person totals, in any form, ever**,
including private ones: any per-person number gets read as a grade by a
seventeen-year-old regardless of the caveats. And **runs are the portal's own
observations while commits are supplementary evidence with honest gaps**. Two
of five teams bulk-uploaded their code, so every commit-derived signal
degrades to "history starts here" for them, stated plainly. Never interpolate.

## What this forbids

- **A score-ordered leaderboard as a featured surface.** The existing public
  leaderboard becomes a recency-ordered gallery of findings: each team's curve
  shape and one line on their approach, no rank column. Keep the visibility,
  drop the ordering.
- **LLM-generated process narratives.** Wrong twice: the portal would claim
  things it cannot verify about who did what, and a wrong generated claim
  about a teammate is socially expensive in a way a wrong number is not.
  Template sentences from observed diagnostics are the ceiling.
- **Auto-suggested hyperparameters.** "You guys will figure out how much fan
  out" is the course handing students an engineering problem. Proposing values
  takes it back and converges every team onto one configuration.
- **Badges, streaks, completion percentages.** Each converts the instrument
  back into a target.

## Build order

1. Sweep support in the benchmarks, and the run-page trace.
2. The finding sentence and the stage rail.
3. First light, and the Discord nudge.
4. Stage footprint and the ownership map.
5. The gallery reframe of the leaderboard.

Items 1 and 3 carry most of the value. If scope forces a cut, cut 4 before 3.

## What would change this

The sweep assumes subset evaluation is cheap. That holds for Week 1, where
nested subsets query one database built once. Verify it for Weeks 2 and 3
before committing the run page to a curve; a week whose sweep is genuinely
expensive gets three points instead of a curve, and the layout survives.

Stage attribution assumes file paths map to stages. Check the five real
repositories before building it; if more than one defeats path mapping, lean
on run-derived signals instead.
