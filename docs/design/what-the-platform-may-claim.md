# What the platform may claim

**Status:** design direction, 2026-08-20. Written after the platform told a
student their code could not be wired up, when the truth was that we never
read it.

## The failure this exists to prevent

Three Week 2 repositories were reported `NOT_WIRED`, which means "we read your
code and could not find a working pipeline in it." That was false. What
actually happened, measured by running discovery directly instead of through
its reporting wrapper:

```
read  : ['recognizer', 'profile', 'similarity']
SKIP database    ImportError: attempted relative import with no known parent package
SKIP whispers    imports facenet_models, which is not installed here
SKIP normalize   imports cv2, which is not installed here
```

The clustering algorithm is in `whispers`. It was never imported, so it was
never searched. The verdict asserted a thing the run had no evidence for.

Both skips are ours. `cv2` and `facenet_models` are installed in the Modal
image that scores Week 2, so their absence is a fact about the laptop the
preview ran on, not about the submission. The relative-import failure is a
loader defect: a module inside a package has to be imported as part of that
package, and ours imported each file standalone.

Two days went into making the search cleverer before anyone checked whether
the search was being shown the code.

## The rule

**A verdict is an assertion, and the platform may only assert what the run has
evidence for.**

That sounds obvious. It was not being followed, and the reason is worth
stating: `NOT_WIRED` and "we could not read it" were being decided on one
axis, so a partial read had to round to one or the other. It rounded toward
the confident one.

## Three parts, each doing one job

### 1. Coverage travels with every verdict

What was read, what was skipped, and why, is not a verdict. It is a property
of the run that every verdict carries. This matters most in the case a sixth
verdict would not have caught: if a team's best implementation sits in a
module that failed to import, the search binds a weaker candidate from what
remains and reports `SCORED` with a real number that is wrong for that
repository. The corrupted verdict there is `SCORED` itself. Coverage is
orthogonal to the conclusion, so it cannot live on the same axis.

### 2. Skips have owners, and the owner decides what may be rendered

**Platform defect.** A stub for a package the scoring image installs, or a
loader bug. No verdict may be rendered at all. The run is a platform error.
An instrument that knows it is out of calibration declines to give a reading,
which is a different thing from giving a low one.

**Honest environmental absence.** The package is genuinely absent from that
track's image. The verdict renders and the coverage record names the package.
This is a service: an official run fails the same way, so saying it early is
the whole point of a local check.

**Student code defect.** A syntax error, or a module that crashes on import.
The verdict renders and the coverage record attributes it, and the
attribution is now true, which it was not before.

### 3. Verdicts carry preconditions, checked at construction

The five verdicts do not change. Each gains a condition that must hold before
it can be built, and building one whose condition fails raises:

- `NOT_WIRED` requires that every module which could have held a candidate
  imported successfully. Otherwise the run did not read the code.
- `NOT_READ` requires that none did.
- `SCORED` and `WIRED_BUT_WRONG` require that the bound chain's modules
  imported and that no platform-defect skip occurred anywhere in the run. If
  a candidate-bearing module was honestly skipped, the verdict must say the
  score is of what was readable.

The point of putting the condition in the constructor is that widening a
verdict now means editing a stated precondition in one named place. The way
this defect actually arrived was quieter than that: nobody decided to widen
`NOT_WIRED`, it just gradually covered more cases as classifier control flow
grew.

## Why the fix is not a sixth verdict

The obvious repair is a new state meaning "read part of it, and the part we
could not read is where the pipeline lives." It is the wrong shape, for a
reason worth keeping: the `SCORED`-on-partial-evidence case above is not
covered by it, because that run's verdict is not the new state. Any repair
that lives on the verdict axis leaves that hole. Coverage has to be a
separate axis, and once it is, the sixth state is unnecessary.

## The environment is a parameter, never ambient

The same defect in a different place. A stub is honest only when it
reproduces an absence the scoring environment actually has; a stub for a
package the image installs manufactures a failure and bills it to the student.

There are three scoring environments, not one. Week 2 runs student code on
Python 3.11 with torch, opencv, scikit-image and networkx. Week 1 and Week 3
run it inside a pinned CPython 3.8.20 virtual environment, each with its own
package list. So the honest stub list differs per track, and a single global
list cannot be right for all three. `networkx` was stubbed and is installed
in the Week 2 image, which is exactly the manufactured absence, on the scored
path, in the graph library the clustering code imports.

Track-indexing goes further than packages. Week 1 and Week 3 are on 3.8 and
Week 2 is on 3.11, so a file using 3.11-only syntax is readable to one track
and not another. Readability is itself a property of the track.

The stub list should therefore not be authored at all. Anything absent from a
track's image may be stubbed for that track; anything present may never be.
The manifest that builds the images is already the source of truth for hosted
scoring, so deriving from it removes the second, drifting copy. Uniformity
across repositories was never the real protection against hand-wiring;
derivation from production is.

The test, per track T:

```
stubs(T) ∩ image(T) = ∅
image(T) ⊆ importable(discovery environment for T)
```

Three assertions, each naming its track when it fails.

One consequence to accept rather than hide: the same repository can be
readable to one week and not another. That is correct. Discovery is not
answering "what is in this repository," it is answering "what is in this
repository as the Week T sandbox sees it." A report that flattened the two
would be the lie. Every report names the environment it ran under, the way
the stub list is already disclosed.

## The regression fixture, written before the fix

One repository with a candidate-bearing module that fails to import, in each
of the three ownership cases, asserting that the run refuses to produce an
unqualified `NOT_WIRED`, refuses an unqualified `SCORED`, and reports a
platform error on the parity case.

Write it first. The real repositories that produced this lie exist right now,
and they stop being available as evidence the moment the fix lands.

## What this is, in one line

The platform reports a reading together with the conditions under which the
reading is valid. That is what it already asks of the students.

## Who wrote this byte, and had they run student code yet?

The rule above governs what the platform says about a repository. The same
failure has a second form, which is what the platform says about itself.

A failed official run either spends one of a team's three attempts or gives
it back. The controller decided which by reading a marker the sandbox wrote
to stderr, under a comment asserting the submission could not forge it. The
assertion was false: `redirect_stderr` rebinds a Python object and leaves
file descriptor 2 alone, so `os.write(2, ...)` from any student module put
the marker on the pipe the controller reads. Unlimited refunded attempts,
and a run page blaming our model cache for the student's bug.

Two earlier fixes had already moved attribution once each: from the adapter
name, to the words in the exception message, to this marker. Each fix was
locally correct. Each relocated the trusted channel rather than removing the
need to trust, so the third defect is the same defect.

The rule that ends the sequence:

**After a process imports student code, everything it emits is student
speech.** Not stderr in particular. The exit code (`os._exit` beats the
`SystemExit` the runner would raise), the files it writes, the signals it
raises. Containment inside the process is not a boundary against code
running in that process. Only a process boundary, a sandbox boundary, or a
time boundary counts, and the time boundary means bytes written before the
import.

A useful corollary: **the sandbox may confess, never accuse.** A claim
against the writer's own interest is safe to believe, because forging it
costs the forger an attempt. A claim in the writer's favor has to be
computed by the controller from what the controller itself observed.

### The review question

"Can the untrusted party influence this?" was asked here, and answered
wrongly, because it invites a plausibility argument about an abstraction and
`redirect_stderr` was a plausible abstraction. The replacement asks for a
fact:

> For every branch that benefits the submission, name the process that wrote
> each byte the condition reads, and say whether that process had executed
> student code by the time it wrote it. If it had, the branch fails review.

Thirty seconds, and the answer here was "the compromised process, yes."

### The mechanical form

`apps/runner-modal/tests/test_forgery_corpus.py`. One hostile submission per
attack, run through the real sandbox script, each asserting on the outcome
(the attempt was consumed, the failure is the submission's) rather than on
the classifier that produced it. A test written against the mechanism passes
again the moment the mechanism moves, which is exactly how this defect
survived two fixes.

Every historical exploit stays in the corpus after it is fixed, because the
way this class returns is that someone re-adds a channel nobody still tests.
Four of the seven fixtures fail against the code they were written for.

One more rule, which this defect's own comment argues for: **a claim in
prose that something cannot be forged requires a fixture that tries.** Five
lines would have falsified this one the day it was written.
