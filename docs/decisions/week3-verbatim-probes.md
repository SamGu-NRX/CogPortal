# Week 3's scored questions may not be answerable from the file it hands over

**Status:** decided 2026-08-20, before the confirming measurement was taken.
The band in section 3 is written down first on purpose.

## What was measured

Week 3 hands a submission `Resources`, whose `captions_path` is the full
COCO annotations file. That file is the caption-to-image mapping: 400,172
pairs, turned into a dictionary in one pass.

The scored queries are read verbatim out of that same file
(`datasets.py:485`), and the same list is handed to both the retrieval case
and the search case (`datasets.py:526`). So a submission that embeds nothing
can answer them by lookup.

Against the real scorer, on the test tier, using only what the sandbox
receives:

```
overall            0.4822     reference 0.6925
retrieval_mrr      1.0000
search_mrr         0.2710     verbatim rung 0.9520, keywords 0.0279
text_mrr           0.1757     its own floor is 0.1721, so this is at floor
```

`gold_rows` is correctly stripped from the payload. It does not help. The
sandbox recomputes the gold row as the position of `cap2img[query]` within
`pool_image_ids`, and both of those are things the assignment requires:
`prepare_database(image_ids, descriptors)` is the contract.

## Why the payload cannot be stripped further

Weeks 1 and 2 strip their gold because their labels are separable from their
inputs. Week 3's are not. The assignment is to embed those captions, and the
course teaches building an IDF table over the whole corpus, so the corpus has
to be there. The gold and the training data are the same object.

This is train/test contamination rather than a leak, and naming it that way
decides where the fix goes. The defect is not in what the submission holds.
It is in asking scored questions whose answers are strings in what it holds.

## The rule

Assume everything handed to the submission is perfectly memorized, by a
dictionary if not by a network. Every scored probe must still be answerable
only through the competence the week teaches. When gold separates from the
corpus, hold out the gold, which is Weeks 1 and 2. When gold is the corpus's
own structure, hold out or transform the questions, which is Week 3.

A probe needs two properties. The course material must predict the correct
behaviour, which is what makes it legitimate. And the payload must not
contain the answer, which is what makes it valid. The query rewrite grid has
both: each rung is a prediction the course makes, and a rephrased caption is
not a string in the file.

## What changes

Verbatim probes leave every scored aggregate. Scored components average the
three rewritten rungs. The verbatim probe is still run and still reported,
unscored, next to them, because it is the clearest measurement the instrument
has: an honest submission scores about the same on both, and a memorizer
scores 1.00 next to 0.03.

Not a second change on top of this morning's scorer bump. It is the same rule
applied everywhere it binds, versioned once.

## 3. The band, written down before the number

Decontamination must not quietly change what the instrument measures, so the
reference submission is the control. Its search sweep was measured earlier
today for an unrelated reason, which is why this band can be centred on data
that was not gathered to answer this question.

```
R_search    = reference mean(search rungs 2 to 4) / reference search verbatim
R_retrieval = reference mean(retrieval rungs 2 to 4) / reference retrieval verbatim
```

R_search is computed from numbers recorded in migration 0030 before this
question was asked: reference search verbatim 0.6336508, four-rung mean
0.5739670, so the mean of the three rewritten rungs is 0.5541 and

```
R_search = 0.5541 / 0.6337 = 0.8744
band     = [0.7744, 0.9744]
```

**Prediction: R_retrieval falls within 0.10 absolute of R_search, so inside
[0.7744, 0.9744].** The two
components draw from the same query list, so the perturbed strings are
identical between them and only the scoring target differs. The degradation
should transfer.

Two rules about what the band decides, fixed now:

- Above the band, ship. Ceiling effects push a near-perfect verbatim score
  toward a higher ratio, so a high `R_retrieval` is expected rather than
  suspicious.
- Below the band, investigate: a transformation bug, a gold misalignment, or
  a real finding about the reference under IDF weighting.

**In neither case does the verbatim probe return to the scored aggregate.**
The band decides ship against investigate. It never decides decontaminate
against leave it, because that decision is made here, before the number.

The band is not tightened after the number is seen. If the miss is
concentrated in one rung, that is a finding about that rung rather than a
blocker; the band binds on the mean of the three.

## Each metric sits next to its own floor

A floor is per component and never global. `chance_mrr` is the retrieval
floor over a 100-row pool; the text component groups 75 captions into 15 and
has a floor of 0.1721. Comparing `text_mrr` against `chance_mrr` reports a
submission at its floor as 3.4 times chance, which is how a memorizer scoring
nothing looked like it was scoring something during this investigation.

`text_chance` was computed and discarded until this morning, for the same
reason. The rule is one line longer than that fix: a published metric is
shown next to its own floor, and a test asserts against that floor rather
than a shared one.

## 4. The measurement, taken after the band was written

Run on 2026-08-20, after the band above was committed.

**Test tier.** R_retrieval = 0.8744 against R_search = 0.8744, which is
inside the band by a distance of zero. That is too exact to take at face
value, and the reason is already recorded in `docs/design/week3-audit.md`:
on the test tier the reference scores the two components identical to 16
significant figures, because both are handed the same pinned pool over the
same query list, so any cosine top-k search reproduces the controller's own
ranking. The band was near-tautological there.

**Evaluation tier**, where the audit records the two components actually
separating:

```
search    verbatim 0.2572  rungs 2 to 4  0.2221   R_search    = 0.8632
retrieval verbatim 0.2586  rungs 2 to 4  0.2241   R_retrieval = 0.8666
                                         difference             0.0033
```

Inside the band, on the tier where passing means something. Ship.

### One finding worth keeping

On the evaluation tier the keywords rung scores 0.2746 against verbatim's
0.2586. Dropping the stopwords makes retrieval *better*, not merely nearly
free.

That is the course's own claim about IDF weighting, confirmed on real data:
if low-information words carry near-zero weight, removing them cannot hurt,
and where they contribute noise it helps. It also means the pre-registered
expectation of a small drop was the wrong shape for this rung, though the
band was on the mean of three and the mean does fall.

Recorded rather than acted on. A submission whose keywords rung sits below
its verbatim one is doing something the course predicts it should not, and
that is now a readable signal on the run page rather than a number nobody
compares.
