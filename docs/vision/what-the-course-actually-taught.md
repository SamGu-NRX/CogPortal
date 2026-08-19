# What the instructors actually said

**Source:** 19 merged daily transcripts of CogWorks 2026 (2026-07-06 to
2026-08-02), at `~/Email Work/04-CogWorks-all-transcripts/transcripts/by-day`.
Mined and adversarially verified 2026-08-19 by workflow `wf_6bf7e2ee-7b1`;
every quote below was re-read against the file by a second agent whose job was
to refute it. Corrections that survived that pass are folded in. Raw findings,
including the sixteen claims that were refuted or materially corrected, are in
`_research-raw-wf6bf7e2ee.txt`.

This is the evidence base for `ideation-guideline.md`. Where the benchmark
disagrees with this file, the benchmark is wrong.

---

## The purpose, in Reynaldo's words

> "we want to be able to showcase your skill of being able to develop these
> things **as if you were an AI engineer**, if that makes sense."
> — 2026-07-20, 12:49:26

The context matters and was checked: he said it while ruling out tools that
"do most of the work for you." The capstone is not *build Shazam*; it is
*be someone who can build Shazam*.

> "Most of the work goes into processing the data... the amount of work in
> processing the data before and after the fact is the hardest part, and
> designing the input and output of the model is actually critical to any
> successful machine learning AI application."
> — 2026-07-09, 14:54:57–14:56:05, answering Lashika Kapoor asking why week 2
> restarts from scratch

He labeled this "some wisdom" rather than course content. Verification
correction worth keeping: he did *not* say the models don't matter, and he did
not say the weeks are disconnected — his exact next words were "we're going to
be building upon these concepts week over week." The per-modality *techniques*
restart; the concepts accumulate.

## On splitting work across a team

The instructor's answer to "how do we divide this" was, repeatedly, **not**
about division:

> "Remember that making it work with all the pieces together is the most
> important part at the end. So you need to be able to make sure that when
> that does come together your design, your initial design is like well
> thought out."
> — 2026-07-09, 12:54:36

Verification correction: he explicitly declined to prescribe the split itself.
Asked directly by a student how to delegate tasks and handle version control,
he said "Yeah, your TAs are going to give you some advice on how to manage
that. So I don't." The lecture owned *what to prioritize*; TAs owned *who does
what*, in breakout rooms.

The mechanism he did name:

> "Github is going to be absolutely crucial working together as a team,
> because you guys are going to be working on the same code base. And you guys
> need to figure out how you're going to delegate tasks between each other."
> — 2026-07-09, 12:52:54

with modules as the unit of division and a notebook as the integration point.
In the staff-only prep session the same idea is sharper, and it is the closest
thing in the archive to a decomposition rule:

> "Everyone agrees on the inputs and outputs of things. And then when they come
> together, they're able to fit the pieces together... that is the recommended
> way, it's the surefire way."
> — 2026-07-08, 17:34:51, TA prep session — **never said to students**

That last fact is itself a finding: the most actionable piece of team advice in
the archive was never delivered to the people who needed it.

## On evaluation

> "If your library is small, like 5 songs, it's going to be pretty easy. But if
> your library is like hundreds of songs, the problem gets harder... So start
> easy. I recommend start easy and then start growing the library and see how
> your performance either degrades and then do some fine tuning to get it
> better."
> — 2026-07-09, 12:47:33

Difficulty is a knob the team chooses, and the method is sweep-until-it-breaks,
then tune. This is the instructor reinforcing the capstone page's "analyze your
performance" ask, and it is a protocol, not a number.

The knobs were named and deliberately left unresolved:

> "Maybe a fan out of 5 is not what you need. Maybe you need a different fan
> out, maybe 4, 3, 10. I don't know. You guys will figure out how much fan
> out." ... "This is an engineering kind of problem."
> — 2026-07-09, 10:58:33 and 10:15:07

**What the required presentation minimum was:** team name, problem statement,
solution, problems encountered, future work (2026-07-10, 09:10:47). Accuracy is
not on that list.

## The live demo the owner remembered

Verified, and better than the memory of it:

> "for like the benchmark. I have not put together the captions, but I'm
> literally gonna do that during this break. I'm just gonna go to the Coco
> website... and pull out, like, 3 levels of difficulty... And then I'm gonna
> put one that's not in the dataset." ... "Because I don't want people to try
> to optimize after they see the captions."
> — 2026-07-24, 14:04:11 and 14:05:18

An improvised lunch-break gag that is also a correctly-constructed held-out
test set with per-team randomization. Then it ran live, and half of it failed:

> Reynaldo: "I did check. Um, surprisingly, you got one. That's pretty good."
> Shanaya Pal: "So we have 33% accuracy."
> Reynaldo: "No, this one's a toughie. This one's a toughie. It's okay."
> Sriram Gutlapalli: "Okay. Okay. See, the vibes are not great."
> Reynaldo: "All right. Good job, team. Good job. Clap them up, y'all."
> — 2026-07-24, 15:39:13–15:40:09

The final week's rubric was explicitly non-numeric — "approvals or performance
is going to be just vibes. The class is going to have to decide" (14:04:49) —
which a student immediately named:

> "You've heard of vibe coding, you've heard of vibe cadding, now we got, we're
> getting vibe judging here." — Leon Du, 2026-07-24, 14:47:40

## What "good" meant

A student proposed a best-programmer competition. The instructor redirected it
in real time:

> "the goal for this is not to like show up anyone in your team. The goal here
> is to have a team that works effectively right?"
> — 2026-07-09, 14:02:40

Publicly, at the Week 1 close:

> "You guys have gone from like unfamiliar territory to like actually building
> something that kind of works, you know. Feel free to share with your parents
> if they want to see it."
> — 2026-07-10, 16:17:27

Privately, to the TAs, four minutes later:

> "the results are probably sketch. I don't think there was enough rigor there,
> but nevertheless, the fact that they got as far enough to make something and
> test it, um, and, like, almost every team had a demo is pretty nice... this
> is their first time working together, and they figured it out pretty well."
> — 2026-07-10, 16:21:48

**This pair is the single most important thing in the archive.** He names the
weakness — the numbers were bad — and counts the week a success anyway, on
process grounds, in a room with no students in it. That is not rhetoric for the
kids. That is the actual standard.

## What this means for the platform

1. **A leaderboard ordered by score contradicts the course.** "The goal is not
   to show up anyone in your team" was said out loud, to a student, as a
   correction. Any ranking surface has to answer to that sentence.
2. **The rubric the instructor actually used is process-shaped**: did they
   self-organize, did they ship, did they demo, did they test. All four are
   observable, and none of them is the identification score.
3. **"Something that kind of works" is the honest bar.** A platform that
   reports 0.53 as a deficiency is measuring against a standard the course does
   not hold.
4. **Sweep-then-tune is the method students were taught.** A run page that
   shows one number for one configuration does not support the method; a run
   page that shows performance across the difficulty knob does.
5. **Integration is the named failure mode, and the fix was never told to
   students.** A platform that could show a team their integration state — do
   the modules fit together yet — would be delivering the TA-prep advice that
   never made it to the room.
6. **The improvised, unrehearsed, partly-failing live demo is the emotional
   center of the course.** Whatever the platform becomes, it should not make
   that moment less likely.
