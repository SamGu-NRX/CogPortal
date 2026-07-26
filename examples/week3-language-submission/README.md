# Week 3 reference submission

Answers one question: does the language-search benchmark harness measure a
working system correctly? It is a complete, deliberately strong submission
(course-exact IDF-GloVe text pipeline; ridge-trained 512x200 linear image
encoder, see train_reference.py for why ridge) that stays private to this
repository so students never see a finished solution.

- `train_reference.py` rebuilds `weights.npz` in under a minute once the
  GloVe cache exists; training images exclude the manifest builder's first
  three blocks, so no evaluation image is trained on.
- `eval_variants.py` is the local-truth harness: reference must clearly beat
  chance on all three components, an inert adapter must land at chance, a
  broken one must produce a named contract report.

Scores to expect (public splits, seeds pinned): test tier overall ≈ 0.71,
evaluation tier overall ≈ 0.43 against chance MRR ≈ 0.01.
