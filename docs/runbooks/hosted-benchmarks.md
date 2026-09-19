# Running the benchmarks on Modal

How to deploy the runner and score a real repository end to end, and what to
do when it fails. Everything below has been run; the failure section lists
what actually went wrong rather than what might.

## Once per machine

Modal's client needs its own interpreter: the system Python on macOS is
PEP 668 managed and refuses `pip install`, and the deploy script imports both
`modal` and `fastapi`.

    uv venv --python 3.11 .venv-deploy
    uv pip install --python .venv-deploy/bin/python "modal>=1.0,<2" "fastapi>=0.115,<1"

    # The plugins, so the smoke test can build a manifest and score what the
    # sandbox returns. --no-deps: their pins target 3.8 for the sandbox, and
    # this interpreter is 3.11.
    uv pip install --python .venv-deploy/bin/python --no-deps \
        -e python/cogbench \
        -e benchmarks/week1 -e benchmarks/week2 -e benchmarks/week3 \
        -e benchmarks/week2/face_recognition_app \
        -e examples/week1-audio-submission

    # What those plugins and the reference submissions actually import.
    uv pip install --python .venv-deploy/bin/python \
        numpy pytest numba librosa soundfile "gensim>=4.3,<4.4" scikit-image

`.venv-deploy/` is git-ignored.

Each dependency above earns its place by a failure it prevents, all of which
were hit rather than predicted: without `numba` and `librosa` every Week 1
student repository fails at import; without `gensim` the Week 3 reference
scores 0.000 across all three components; without `scikit-image` one Week 2
reference test fails on `skimage`; without `face_recognition_app` installed,
`cogworks.submissions.v2` is empty and Week 2's discovery tests fail.

Verify the whole set with:

    (cd benchmarks/week1 && ../../.venv-deploy/bin/python -m pytest -q)   # 171
    (cd benchmarks/week2 && ../../.venv-deploy/bin/python -m pytest tests/ -q)  # 31
    (cd benchmarks/week3 && ../../.venv-deploy/bin/python -m pytest -q)   # 23

Authenticate once with `modal setup`. `modal profile list` should show a
workspace. The deploy also needs the `cogworks-runner-signing` secret to
already exist in that workspace.

## Deploy

    .venv-deploy/bin/python apps/runner-modal/tools/deploy.py

This builds and publishes the three sandbox images, then deploys the app. Use
it rather than `modal deploy`: `_prepare` creates its evaluation sandbox from
inside a container, and Modal resolves image definitions client-side, so a
container asked to resolve `week1_image` would try to re-read `add_local_dir`
sources from a repository that only exists on a developer machine. Publishing
the images here, where the repository is present, turns them into server-side
objects the container references by name.

Republishing is cheap when nothing changed: `Image.build` returns the cached
image. Changing anything under `benchmarks/`, `python/cogbench/`, or
`apps/runner-modal/src/` requires a redeploy before the sandbox sees it. The
three benchmarks are git submodules, so `git submodule sync --recursive &&
git submodule update --init` before deploying, or the images carry whatever
commit your tree happens to hold, from whichever source it was cloned with.

## Score a repository

    .venv-deploy/bin/python apps/runner-modal/tools/smoke_modal.py \
        --benchmark audio-identification \
        --repo KrazeeCoder/week1-capstone-team4

It calls the same `_prepare` and `_evaluate_week1` the job runner calls, so a
pass here means the deployed path works rather than that a parallel copy of it
does. Add `--sha` to pin a commit; the default is the default branch head.

A pass prints the metrics, the diagnostics, and the provenance line naming
every piece of wiring we supplied, when the repository was scored through an
instructor-written adapter.

Week 1 also prints the sweep sentence, which is the first diagnostic:

    note: Identification falls gradually from 68% at 5 songs to 54% at 30,
    without a single point where it breaks.

Measured on `KrazeeCoder/week1-capstone-team4`, 72 s, `identification_score`
0.5375. The sweep costs no extra calls into student code, so a run with it
takes the same time as one without.

## Week 3

Same deploy. Two smoke tests, because Week 3 has a problem Week 1 does not:
its reference submission lives in this monorepo and is deliberately not
published, so a tarball fetch cannot reach it.

    # Discovery, against a public repository. Expect adapter_missing for any
    # student repository until one carries a submission.py.
    .venv-deploy/bin/python apps/runner-modal/tools/smoke_modal.py \
        --benchmark language-search --repo BagelBreaker/week3_capstone

    # Evaluation, against the private reference. Uploads it into a sandbox
    # built from the published image and runs the same EVALUATE_SCRIPT.
    .venv-deploy/bin/python apps/runner-modal/tools/smoke_week3_sandbox.py

The second should print `overall 0.4329` against `chance_mrr 0.0102`, the
three query rungs (`search_mrr_keywords` 0.2735, `search_mrr_truncated`
0.1671, `search_mrr_typo` 0.2256), and `student python 3.8.20` in the
submission log. Those numbers match what
`examples/week3-language-submission/README.md` documents for the evaluation
tier, which is the point: the harness measures a known-good system correctly.

## When it fails

**`Rendered song-NN does not match`.** The corpus renders differently in the
sandbox than on this machine. Run:

    .venv-deploy/bin/python apps/runner-modal/tools/diagnose_corpus.py

It runs the same ladder of primitives in both places and prints them side by
side; the rows marked `DIFFERS` name the operation. Everything the renderer
uses should go through `exactmath`, so a difference means either a new numpy
call crept into `synth.py` or `exactmath` itself grew one. Background:
`docs/decisions/week1-corpus-determinism.md`.

**`No adapter found in <repo>`.** The repository has no `submission.py` at its
root, no packaging file with a `cogworks.submissions.v2` entry point, and no
instructor adapter under `benchmarks/adapters/<owner>__<name>/`. Adding one of
the three fixes it; adding the third requires a redeploy, since the adapters
are baked into the images.

**`Evaluation ran past its N second budget`.** The submission is too slow on
the evaluation corpus, and the message says the usual reason: a database
re-read or rewritten per song or per query costs time proportional to the
catalog. `carti4ce/week1_capstone` is the measured example at 999 s against
900 s. This consumes an official attempt, correctly: it is the team's
algorithm, not our infrastructure.

**A keyword the current source has, rejected inside the sandbox.**
`__init__() got an unexpected keyword argument ...`, while every local test
passes. A `build/` directory in the benchmark is shadowing the real module:
the image installs with `pip install /opt/weekN`, which builds from source,
and setuptools reuses whatever is already there. `deploy.py` now refuses to
run and names the directory; delete it and redeploy.

**`modal.exception.ExecutionError: ... was modified during build process`.**
A file changed while the image copied it, almost always `.pytest_cache`
because tests were running. `BUILD_JUNK` in `modal_app.py` excludes the usual
suspects; add the path there rather than deleting it by hand each time.

**`AttributeError: module 'modal' has no attribute 'runner'`.** `modal.runner`
resolves through a lazy `__getattr__` with a curated name list that omits it;
`import modal.runner` explicitly. Already done in `deploy.py`.

## What a run costs

About 75 s wall clock for a fast submission on the 30-song evaluation tier,
most of it the prepare sandbox fetching and installing. The evaluation sandbox
runs network-blocked, so anything a submission needs has to be in the image.
