# Week 2 vision submission example

This package is a development fixture that makes the CogBench plugin boundary
concrete. It is not the course capstone answer and is not a canonical student
template. The synthetic public cases contain small embedding vectors; this
adapter uses cosine similarity and a fixed unknown threshold solely to verify
installation, entry-point discovery, execution, and reporting.

From the CogPortal monorepo root, activate the same conda environment used for
the CogWorks prerequisites and install all three local packages:

```sh
conda activate cogworks_week1
python -m pip install -e python/cogbench -e benchmarks/vision-recognition -e examples/week2-vision-submission
```

The command is intentionally written with `python -m pip`, so installation and
execution use the same interpreter on macOS, Linux, and Windows.

The package advertises this adapter through standard Python package metadata:

```toml
[project.entry-points."cogworks.submissions.v1"]
vision-recognition = "cogworks_week2_submission:Week2VisionSubmission"
```

CogBench loads the class and calls `predict(inputs)`. A student template should
preserve that small boundary while replacing `predict_one` with its Week 2
preprocessing, embedding, and recognition pipeline. Inputs and predictions must
remain JSON-serializable; the adapter must return exactly one prediction per
input.

Do not install this example into an environment that already contains a real
`vision-recognition` submission plugin. CogBench rejects duplicate registrations
instead of choosing one unpredictably.
