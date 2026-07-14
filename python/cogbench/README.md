# CogBench

CogBench runs public CogWorks practice benchmarks locally. `doctor`, `test`,
`run`, and `report` work without a CogPortal account and without network access
after the project and its benchmark plugin are installed.

```sh
python -m pip install -e .
cogbench doctor --benchmark vision-recognition
cogbench test --benchmark vision-recognition
cogbench run --benchmark vision-recognition
```

`cogbench link` and `cogbench sync` are optional. Sync uploads only the selected
structured report; it does not upload source code, files, datasets, environment
variables, or arbitrary logs.
