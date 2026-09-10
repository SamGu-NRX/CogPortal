# 0002 — Week 2 vision benchmark boundary

Status: proposed in upstream draft PR 1; parent integration pinned for review.

## Decision

The Week 2 benchmark is Reynaldo's work, developed at
`iReynaldo/ComputerVisionBenchmark`. CogPortal consumes it through
`SamGu-NRX/cogworks-week2-vision-benchmark`, a fork of that repository, as the
pinned HTTPS submodule `benchmarks/week2`. The fork shares upstream's history, so
the commit this parent pins resolves there unchanged, and Week 2 now comes from
the same account as Week 1 and Week 3. That account matters because every clone
of CogPortal fetches this submodule: if the source repository goes private, is
deleted, or rewrites the history holding the pinned commit, the checkout breaks
for everyone and we cannot repair it from here.

Development happens on `sg/week2-benchmark-adapter`, which the fork carries at
the same head as upstream; the parent gitlink moves only to reviewed commits, and
upstream remains the source the fork tracks.

The existing v1 fixture and example remain on disk temporarily with deprecation
markers, but no active install, runtime, documentation, catalog, or CI path uses
them.

Students retain control of their application architecture. Two raw
`cogworks.submissions.v2` factories receive the shared CPU FaceNet model and
return thin recognition and clustering adapters. Automatic compatibility is
limited to Reynaldo's complete documented `FaceRecognitionApp` surface. Other
designs receive a mapping report and implement `benchmark_adapter.py`; the
runner never guesses from filenames or approximate method names.

## Course evidence

The facial-recognition capstone describes a holistic application: build a known
face database, reject a new person, then add that person. The Whispers portion
adds clustering a stack of face images. The later portion of `transcript.txt`
made these three behaviors explicit, selected CelebA, rejected scoring the
shared detector/model, and separated a smaller local test set from evaluation.
It also proposed calibration against a prior or reference implementation.

`transcript2.txt` sharpens the distribution boundary: students should receive
an interface-only, separately forkable template rather than the completed
application; the CLI/portal path should be jointly verified and cover macOS and
Windows. The subsequent repository review clarified that Reynaldo's completed
`face_recognition_app` must remain upstream as the golden end-to-end fixture.
The future student starter is a separate concern and can later be created at
`CogWorksBWSI/week2-vision-capstone` with clean history. This preserves both the
working reference implementation and students' freedom to choose another
architecture.

## Scoring and trust

Recognition reports macro known identification and an unknown lifecycle (mean
of rejection and post-enrollment accuracy). Clustering uses label-invariant
pairwise F1. Vision Overall gives each of those three behaviors one third of the
score. It exists only when the selected official recognition and clustering
runs have the same stored repository ID and commit SHA.

Public manifests are fixed, versioned, disjoint, and cache only selected CelebA
rows. Official manifests and labels remain in the trusted controller; the
student sandbox is network-disabled. Provider data failures do not consume an
attempt. Student-authored tests remain optional, private, and unscored.

## Operational consequence

GitHub source archives do not contain submodules. Development and deployment
must use a real checkout:

```bash
git clone --recurse-submodules https://github.com/CogWorksBWSI/CogPortal.git
git submodule update --init --recursive
```

Each accepted upstream release requires a deliberate parent gitlink bump and an
update to `scripts/validate_week2_submodule.py`.
