# The Cog\*Portal voice

**Status:** style reference for every word the portal shows a student
**Sources:** CogWorks 2025 course notebooks (Weeks 1–3) and Ryan Soklaski's CogWeb site (rsokl.github.io/CogWeb), analyzed 2026-07-14.

## 1. What the course actually sounds like

The people who wrote CogWeb and the course notebooks write like instructors
standing next to you at a lab bench. Some verbatim evidence, because the point
is to imitate the real thing rather than a memory of it:

On motivation before instruction:

> "Nowadays, most phones come with software that lets them do a pretty neat
> trick: if you're out and about and some music catches your ear, you can hold
> your phone up in the air and ask it to name that tune!" (CogWeb, Audio)

On honesty about difficulty:

> "With digitized audio data in hand, we'll find ourselves with a real mess;
> in its raw form, it is hard to visually discern any salient qualities from
> an audio signal's waveform besides stark changes in loudness." (CogWeb, Audio)

On reassurance backed by evidence instead of cheerleading:

> "Past CogWorks students did not have calculus and linear algebra experience,
> and completed this course with great success; it did require them to put in
> some extra individual effort to understand these concepts." (CogWeb, prereqs)

On encouragement tied to a concrete checkpoint:

> "Each paw print should have five distinct peaks -- one for each pad in the
> puppy's paw. If this is what you see, success! We are now finding local
> peaks in 2-D data!" (Week 1, PeakFinding)

On protecting the student's time:

> "Note: **Do not spend more than five minutes on this**. Once you hit five
> minutes, skip this and move on! It is totally optional." (Week 1, DFT)

On personality that stays humble:

> "I worked pretty hard on these drawings, please don't make fun of them."
> (CogWeb, Audio)

On opinion with a technical rationale:

> "NumPy is the cornerstone for nearly all numerical and scientific computing
> software in Python, and thus it is desirable for us to spend our time focused
> on learning NumPy rather than splitting our attention across multiple
> array-math libraries." (Week 2, Autodiff)

## 2. The principles

1. **We are in this together.** The default pronoun is "we" and "us" for
   anything explanatory ("we'll find ourselves with a real mess"). "You" and
   "your" appear for instructions and for things the student owns ("your
   fork", "your team"). "I" almost never appears.

2. **Say why before saying what.** Even a two-line instruction gets a clause
   of motivation. The course never opens with a bare definition or a bare
   command. In UI terms: a panel's first sentence earns the panel.

3. **Plain talk about hard things.** When something is messy, slow, or
   optional, say so in ordinary words: "this is a real mess", "this is
   totally optional", "this can be much slower". Never hide difficulty and
   never dramatize it.

4. **Reassure with evidence, not enthusiasm.** "Past students completed this
   with great success" beats "you've got this!". Checkpoints beat praise:
   "If this is what you see, success!"

5. **Warmth lives in the material, not in flattery.** The authors get excited
   about a waveform being beautiful or a dataset being adorable. They never
   tell the student they are amazing. The portal can be fond of the work; it
   should not compliment the user.

6. **Instructions are bare imperatives with the gotcha attached.** "Evaluate
   the temporal waveform... **using the sampling rate 44100 Hz**." One verb up
   front, the constraint bolded or stated in the same breath, and the reason
   nearby: "This is to prevent us from accidentally swapping numbers."

7. **Contractions are normal.** "We'll", "it's", "don't". Reads as a person.

8. **Name the reader's likely feeling, then defuse it plainly.** CogWeb
   addresses "the wary student" and says intimidation "is certainly not the
   case!" The portal can do the same at moments of doubt (first sign-in,
   first failed run).

## 3. What never appears (and must not appear in the portal)

- Marketing tone of any kind: no "unlock", "seamless", "supercharge",
  "effortless", no superlatives about ourselves.
- Tricolons and rhetorical triads ("fast, simple, powerful").
- "Not X, but Y" reversal constructions.
- Dramatic one-word or fragment sentences for effect.
- Cheerleading ("You're doing great!", "Awesome!").
- Urgency or FOMO ("Don't miss out", "Hurry").
- Emoji.
- Em dashes in portal copy. The course authors do use dashes for genuine
  asides, but portal copy keeps to commas, parentheses, and the occasional
  semicolon; parentheses are the house move for a soft aside. (This is a
  product decision: short UI strings wear dashes badly, and the dash-as-beat
  is the most recognizable AI-slop tell.)
- Exclamation points are allowed but rationed: only for a genuine checkpoint
  or reassurance, in the corpus style ("If this is what you see, success!"),
  at most one on screen at a time.

## 4. House patterns for UI strings

- **Buttons:** bare imperative, no cleverness. "Create team", "Join",
  "Approve device". Confirmations state the consequence: "Confirm, history
  stays with the team".
- **Empty states:** one plain sentence about the state, then the next action.
  Never apologize ("No repositories are visible yet" is a fact, not a
  failure).
- **Errors:** what happened, then exactly one next action, in the voice of a
  TA who has seen this before. "That code doesn't match. Check the code your
  instructor shared." Pitfalls are collegial, never alarmist.
- **Help lines under controls:** one sentence of why, one of how. "Use
  `python -m pip` so the installer and your Python stay in the same
  environment."
- **Kickers and labels:** mono, uppercase, factual. Labels state nothing that
  isn't information.
- **Trust language:** the portal only claims what it can see. "Verified"
  means the portal observed it; anything on the student's machine is theirs
  to confirm. Scare quotes around anthropomorphized terms follow the course
  habit ("the portal 'sees' only what you sync").
- **Length:** the course tolerates long sentences in exposition but the
  portal is an instrument panel; prefer one medium sentence, then stop. If a
  second sentence isn't information, delete it.

## 5. Before and after, using real portal copy

- Before: "No rush — this guide keeps your place."
  After: "No rush. The guide keeps your place."
- Before: "Everything the portal can verify checks out. Good hunting."
  After: "Everything the portal can verify checks out. If your local runs
  look healthy too, you're ready for a practice run."
- Before: "Your teammates went ahead — find them"
  After: "Someone on your team went first. Find them here."
- Before: "The repository is the team — everyone with write access shares
  its attempts."
  After: "The repository is the team; everyone with write access shares its
  attempts."
- Before: "Adding here doesn't touch GitHub — also invite them as a
  collaborator on the fork so they can push."
  After: "Adding someone here doesn't touch GitHub. Invite them as a
  collaborator on the fork too, so they can push."

## 6. A note on scope

This voice is for student-facing surfaces: onboarding, setup, teams, runs,
errors, docs. Operator/runbook text stays terse and technical. When in doubt,
read one of the excerpts in §1 aloud, then read your draft aloud. If your
draft sounds like a product and the excerpt sounds like a person, rewrite.
