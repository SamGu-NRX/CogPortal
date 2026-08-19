# What CogPortal is for

**Status:** the owner's direction, recorded 2026-08-18. This is the guideline
every later design decision in this repository answers to. The benchmark work
is the MVP; it is not the point.

The first section is the owner's own words, lightly punctuated and paragraphed
and otherwise unedited, because paraphrasing it is exactly how the intent gets
lost. Everything after it is ours: what we read the direction to mean, and what
it forbids.

---

## In the owner's words

> I want the benchmark to be a bit more opinionated because, based on the
> research you probably already did and my discussions with Ronaldo and
> everyone, the platform is supposed to be quite opinionated. The computer
> vision benchmark was what was pre-created previously, and that's maybe the
> depth you need to create for that.
>
> There have already been a lot of decisions made regarding CogPortal designs,
> and you should know it by heart at this point. I gave you all five groups,
> all three repos, and essentially, it should work at this point. I want you to
> think about what the relationships between all that I designed is, like the
> remote model runner, the website interface, and how students should be
> encouraged to use Git effectively.
>
> The creation and splitting of tasks may also be something we can take a look
> at, like commit leaderboards or, based on a particular feature, how much code
> one person output. All of these things are really interesting and something
> you can expand upon beyond just the standardized metrics part, which I
> believe is also still very important and something you need to focus on. But
> it can be more opinionated and a lot less strict on just analyzing the
> performance of something.
>
> It's opinionated in the sense that it is by the official sources, but it
> doesn't necessarily have to be like, "okay, if you have higher pure
> performance metrics on the data set that we have, that's just what it is."
> There are a lot of ways you can take it, and I want you to be very creative
> rather than sticking to something that seems corporate. At the end of the
> day, we want to teach students how to build AI well.
>
> Maybe by enabling this, we could take what we learned from the platform and
> incorporate it into the actual instruction itself. I feel like students
> struggled, especially with the capstone project, with understanding beyond
> the individual level, since some people do a lot of the work. In an actual
> project you don't need to, and probably shouldn't, understand everything
> yourself. You should focus on what you're building. Also, people take their
> projects in different directions, but you need to think about what, after a
> week or half a week of instruction, the project is supposed to outline and
> have the students implement via this hands-on learning method.
>
> That's the very end goal of the platform. Currently, you're just building out
> the MVP, which is essentially the benchmark aspect. But I want you to think
> about the commits piece and come up with a plan for this step while you're
> implementing the rest of the site.
>
> The workflow is probably really clear, but there's a lot you can take from
> this platform, and it's not limited to just what I say. You can take a look
> via my class transcripts, which I have stored, to see what the teaching
> content is like... For this reinforcement, you want to think about the
> purpose of this platform. For example, if you wanted the entirety of BW side
> to use it, what would it be?
>
> Again, the benchmark code probably needs to be GitHub submodules and
> subrepos... The goal is not to create the same testing platform that the
> students should train on, it's not 100% that. Maybe you can look for your own
> datasets that would add fun to the course as well, just like how we did for
> the captions week. Ronaldo looked up some interesting captions and did a live
> demo, and that was pretty interesting. It adds an exciting unknown factor.
>
> You shouldn't think about the benchmark for the students as something to
> optimize for, where the bigger number means better. I mean, that's sort of
> true, and having bigger numbers is something really cool, but we also need to
> encourage variations within the projects maybe. I know that's hard to
> comprehend and hard to implement at this stage, but that will be planning for
> the next stage. What you'd do in this stage is get the fundamentals and just
> the standardized benchmark. But you also need to remember the opinionation of
> it.

Earlier direction that still binds, from the same owner:

> The important idea is to have something that works... I just want a working
> benchmark that's reliable and also adapts to the students' code base.

> 100%, 10% effort in the planning and iterations stage. [Think exhaustively
> when planning; allocate implementation effort dynamically to whatever makes
> it work.]

> The rigor and strength needs to come from within, i.e. in the actual
> architecture and setup in the code.

---

## What "opinionated" means here

Opinionated does not mean strict. It means the platform takes positions, and
every position it takes traces to the course's own material rather than to our
taste in software.

The distinction that matters: a strict platform says *your number is 0.53, and
that is what it is*. An opinionated platform says *your number is 0.53, here is
which part of the capstone produced it, and here is what the course told you
about that part*. The first is a scoreboard. The second teaches.

Concretely, this is already the rule the metrics follow. `metric_help` on every
benchmark carries one or two sentences per metric in the course's vocabulary,
naming which part of the capstone the number comes from, and
`test_metric_explainability.py` fails a benchmark that reports a number it
cannot explain. Week 1's `pitch_top1` is labeled "NOT part of the assignment"
in its own help text, because the course never asks for pitch robustness and
pretending otherwise would be our opinion masquerading as theirs.

The source of every opinion is `docs/cogweb/` -- all 84 pages of the course
textbook, mirrored -- and `docs/capstones/`. When the benchmark and those
disagree, those are right.

## What the platform is for, beyond scoring

The owner names a specific failure: *students struggled with understanding
beyond the individual level, since some people do a lot of the work.* That is
not a scoring problem and no leaderboard fixes it.

It suggests the platform's real subject is the **team's process**, of which the
benchmark score is one observable among several. Others available to us, none
built yet:

- **Contribution shape from git.** Not "who wrote the most lines" -- that
  rewards verbosity and punishes the person who deleted 400 lines of dead code.
  Closer to: which capstone stage did each commit touch, and did the team's
  work spread across the pipeline or pile onto one stage. The capstone has
  named stages (spectrogram, peaks, fanout, database, query for Week 1), so a
  commit can be attributed to a stage by the files it touches.
- **Whether the team's split matches the course's own suggested split.** The
  Week 1 capstone page literally lists how groups "might break tasks down."
  A team that mapped one person per bullet is doing the thing the course asked.
- **Coverage of the assignment, not just performance on it.** A team that
  implemented database save/load, song deletion, and duplicate guarding did
  more of the capstone than a team with a marginally better identification
  score and none of it. Those are listed as optional in the course; a platform
  that only reports one number tells them optional means worthless.

This is the "commits piece" the owner asks for a plan for, and it stays a plan
in this stage.

## What this forbids

- **Ranking as the only verb.** A run page that shows a number and a position
  and nothing else has failed, however correct the number is.
- **Metrics we invented because they were easy to compute.** Every scored axis
  answers a question the course asks. Week 1's grid currently fails this in
  spirit -- three of four scored axes do not discriminate between real
  submissions -- which is why its catalog row ships inactive.
- **Optimizing the benchmark into a target.** The owner is explicit: bigger is
  not simply better, and the next stage is about encouraging variation between
  projects rather than convergence onto our test set. Any design that makes
  teams' code more similar to each other is going the wrong way.
- **Corporate defaults.** No dashboards for their own sake, no vanity metrics,
  no "engagement." If a feature would look at home in a SaaS analytics product
  and nowhere in a classroom, it is wrong for this.

## The scale question

The owner asks: *if you wanted the entirety of BWSI to use it, what would it
be?* BWSI runs many courses; CogWorks is one. A platform that generalizes is
one where a course supplies its own capstone definition, its own vocabulary,
and its own benchmark plugin, and gets the run infrastructure, the git-process
view, and the explanation layer for free. That is an argument for the plugin
boundary being the extension point, and against anything CogWorks-specific
leaking into the portal itself. It is not an argument for building any of that
now.
