# One instrument for every capstone

*For the director of Beaver Works Summer Institute, from the CogWorks
staff. August 2026.*

On July 24, during a lunch break, Reynaldo built a demo-day benchmark by
hand. "I have not put together the captions, but I'm literally gonna do
that during this break. I'm just gonna go to the COCO website and pull out,
like, 3 levels of difficulty. And then I'm gonna put one that's not in the
dataset." He randomized which captions each team got, "because I don't want
people to try to optimize after they see the captions," then ran every team
live on the projector. Half of it failed. One team got one caption out of
three, a student announced "See, the vibes are not great," and Reynaldo
closed with "Good job, team. Clap them up, y'all."

That hour was a correctly constructed held-out evaluation, run live, with
partial failure treated as normal in front of the whole room. It was the
best hour of the summer, and it existed because one instructor gave up a
lunch break to improvise it. This year we built that hour into software for
CogWorks. This document argues it should serve the institute.

The observation it rests on: every BWSI course ends the same way. Teams of
four or five, one shared git repository, a demo day. The benchmark is
different for every course and genuinely expensive to build. The team
process is the same in every course, and no course has an instrument on
it. Staff see the demo. Nobody sees the three weeks before it.

## What runs today, on real student code

Three CogWorks benchmarks score actual student submissions against a
hidden dataset, inside a network-blocked sandbox on Modal. Two real Week 1
team repositories have been scored end to end on the hosted path, at
0.5375 and 0.5292. The runner finds a team's code by reading one
`submission.py` at a known path, because when we checked all thirteen real
2026 repositories, none had Python packaging, and a tool that demands
packaging from high schoolers fails on day one.

Every metric the portal reports carries an explanation written in the
course's own vocabulary, and this is enforced mechanically: a test fails
any benchmark that reports a number it cannot explain. When a submission
breaks, the team reads what went wrong in course terms, never a bare score
near chance with no reason attached.

Around the benchmark sits the part that transfers. A published template
repository gives each team one repo for all three weeks, with an opt-in CI
check that verifies the pieces still fit together on every push. A Discord
bot links accounts, posts live run results to team channels, and sends a
scheduled nudge when nothing has run end to end. A process module reads
the git history every course already produces into four signals:

- Stage footprint: whether the week's work spread across the pipeline or
  piled onto one stage.
- First light: the first run that executes end to end, and the count
  since. Integration made visible.
- Boundary churn: interface changes after integration, each one a breaking
  event worth naming.
- Ownership breadth: how many people have touched each stage. A bus-factor
  map for a team of four.

One rule is enforced by a test that fails the build: no per-person
metrics, in any form. A seventeen-year-old reads any per-person number as
a grade regardless of the caveats, and the instructor set the standard out
loud when a student proposed a best-programmer contest: "the goal for this
is not to like show up anyone in your team. The goal here is to have a
team that works effectively right?"

## Why process is the right thing to measure

At the Week 1 close, Reynaldo told students they had gone "from unfamiliar
territory to actually building something that kind of works." Four minutes
later, to staff only: "the results are probably sketch. I don't think
there was enough rigor there, but nevertheless, the fact that they got as
far enough to make something and test it... I'm pretty impressed." He
named the numbers as weak and counted the week a success anyway, on
process grounds, in a room with no students in it. That is the standard
the course actually holds, and it is the standard the portal measures. The
score sits on the page in small type; the integration state and the stage
map carry the weight.

The measurement itself follows the course's own method. Students are
taught to "start easy and then start growing the library and see how your
performance degrades." Week 1 now reports exactly that: score as the song
library grows, and the run page draws that curve above the number. The
sweep costs nothing extra: we verified that restricting the full ranking to
a subset matches an actual re-enrollment of the smaller library exactly, to
four decimal places, on 80 of 80 queries.

## What happens when the best TA graduates

The most useful piece of team advice in our transcript archive was given
in a staff prep session and never reached students: "Everyone agrees on
the inputs and outputs of things. And then when they come together,
they're able to fit the pieces together... it's the surefire way." When a
course's best staff leave, this is what leaves with them. The template
repo's CI check and the first-light signal are that advice turned into a
standing mechanism. It runs whether or not this year's TAs know to say it.

The same signals give staff a triage console. Ten TAs cannot read forty
repositories, but a console can answer the questions TAs actually triage
by: which teams have not integrated yet, which stages have a single owner,
which teams have not run since Tuesday. Staff hours go to the teams the
instrument flags instead of the teams that ask loudest, and a new TA
inherits the console on day one instead of rebuilding a graduate's
intuition from scratch.

## What another course brings, and what it gets

The benchmark is per-course and expensive. Everything else is shared. A
course supplies three things: its capstone definition, its stage
vocabulary, and one benchmark plugin. It gets the sandboxed runner, the
explanation layer, the Discord surfaces, the process view, and demo day
mode without building any of them. RACECAR's stages are perception,
planning, and control. Cyber's are recon, exploit, and report. First light
and ownership breadth mean the same thing in every one of them.

Demo day mode is the lunch-break story as a feature. The instructor drops
a small fresh dataset that morning, the portal randomizes it per team and
runs every team live on the big screen, and partial failure is visible and
fine, the way it was on July 24. The applause line stays with the
instructor. The lunch break comes back.

## What this does not do yet

The honest list, before any decision:

- The four process signals are computed and tested but not on a page yet.
  The triage console is the design for that page.
- Only CogWorks has benchmark plugins. A second course's plugin is real
  work for that course's staff, on the order of an assignment they already
  write.
- Hosted execution sits behind a configuration flag until it runs on
  program-owned Modal credentials rather than a developer account.
- Demo day mode is not a shipped button. The pieces it needs, the sandbox
  and the hidden-dataset machinery, are the pieces that already run.

## The ask

Name one course as the second tenant. RACECAR is the obvious fit: its
capstone already decomposes into perception, planning, and control. We
need one hour with its lead instructor to write down the stage vocabulary
and what a run means, plus read access to one past summer's capstone
repositories. Before the winter curriculum meeting we will bring back
those repositories rendered in the process view, in RACECAR's own words,
and a one-page demo day plan for their instructor to keep or kill.
