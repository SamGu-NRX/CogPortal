# Testing the reference application and student capstones

Your tests are for fast feedback on the choices your team makes. They are not
scored, counted, uploaded separately, or required to follow a particular module
layout.

Use four progressively broader checks:

1. `pytest` runs your fast tests with arrays and a fake model. No network or
   model checkpoint is needed.
2. `cogworks test vision-recognition` or `vision-clustering` runs the small
   public real-data integration set.
3. `cogworks run ...` runs the larger public evaluation set.
4. The portal runs a disjoint hidden evaluation in a network-disabled sandbox.

## Useful test shapes

Follow arrange / act / assert: create a small database state, call one behavior,
then check only the result that matters. Parametrize the same test across
several identities or thresholds instead of copying it.

Important boundaries include a distance exactly at your match threshold, an
empty database, an unknown face, and adding that same person before a second
query. For clustering, test relationships rather than literal cluster names:
`["a", "a", "b"]` and `[7, 7, 2]` describe the same partition.

If your team adds persistence, a UI feature, alternate distance functions, or
another nonstandard behavior, add a focused test for it. The course benchmark
will intentionally know nothing about those architectural choices.
