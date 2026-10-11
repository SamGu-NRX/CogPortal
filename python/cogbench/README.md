# CogWorks Benchmark CLI

`cogworks-benchmark` is the lightweight, offline-first command-line package
for CogWorks practice benchmarks. The distribution and terminal command have
different names on purpose:

```text
install: cogworks-benchmark
run:     cogworks
module:  python -m cogbench
```

The student install, from this repository's branch while PR #1 is open (TestPyPI holds 0.1.0, which has no resolver):

```sh
python -m pip install --upgrade "cogworks-benchmark @ git+https://github.com/SamGu-NRX/CogPortal.git@fix/product-description-triage#subdirectory=python/cogbench"
cogworks --help
```

From this monorepo, developers can instead use an editable install:

```sh
python -m pip install -e python/cogbench
cogworks --version
```

## Student workflow

The portal supplies the correct origin in the first command:

```sh
cogworks link --portal https://portal.example
cogworks check --benchmark vision-recognition --update-setup
```

`link` is visibly online and stores a revocable device credential. The
`--update-setup` flag makes that one otherwise-local command send coarse
pass/fail milestones to CogPortal. If the local check succeeds but the portal
cannot be reached, the CLI prints both outcomes and exits 2; it never queues a
background upload.

Without the flag, `check`, `test`, `run`, and `report` do not contact
CogPortal. Real-data `test` and `run` may fetch public benchmark/model assets
on first use and then work from the warm cache.

```sh
cogworks check --benchmark vision-recognition
cogworks test --benchmark vision-recognition
cogworks run --benchmark vision-recognition
cogworks report
```

Explicit network actions remain separate: `link`, `sync`, `status`,
`run --live`, and a local command carrying `--update-setup`. None upload
source code, arbitrary files, environment variables, predictions, or logs.
