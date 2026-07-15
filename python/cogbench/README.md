# CogBench

CogBench runs public CogWorks practice benchmarks locally. `doctor`, `test`,
`run`, and `report` work without a CogPortal account and without network access
after the project and its benchmark plugin are installed.

From the monorepo root, install the SDK, benchmark contract, and development
submission example into the active CogWorks conda environment:

```sh
python -m pip install -e python/cogbench -e benchmarks/vision-recognition -e examples/week2-vision-submission
cogbench doctor --benchmark vision-recognition
cogbench test --benchmark vision-recognition
cogbench run --benchmark vision-recognition
cogbench report
```

The example submission exists only to exercise the platform locally. A real
student repository provides its own `cogworks.submissions.v1` entry point.

`cogbench link` and `cogbench sync` are optional. After the device, Discord
account, team, repository, and team channel are linked, a student can opt into
one live team bubble for a run:

```sh
cogbench run --benchmark vision-recognition --live
```

The CLI sends four small lifecycle events and the final structured report to
CogPortal. CogPortal edits the same Discord message at every stage. It never
uploads source code, predictions, files, datasets, environment variables, or
arbitrary logs. A local score remains self-reported and cannot be promoted;
the next action is hosted verification in CogPortal.
