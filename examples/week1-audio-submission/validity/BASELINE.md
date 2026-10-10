# Baseline receipt — week1 audio validity study, recovered branch

Written at recovery onto `obv/products-audio-validity-20261009-r1`, before
any measurement-tier run. Every pin, command, and count below was executed
on this branch in this session.

## Source pins

| what | value |
| --- | --- |
| base branch | `fix/device-link-recovery-20261004` at `276da32fc2e6ea3849a06c8c0d5f37417ba31da1` |
| study branch | `obv/products-audio-validity-20261009-r1` |
| recovery commit | `ebdb309` — cherry-pick of the pre-crash freeze `84d5c93` (identical tree) |
| benchmark submodule | `benchmarks/week1` at `4e516f39ffbeefe579e093260b2865eb354c17a7` |
| other submodules | `benchmarks/week2` at `a3dd948d0c108fabf070b4f159acdecd4d6c3897`, `benchmarks/week3` at `4b1755433110b387b8a37021ef173300636d3b8c` (initialized for the runner-modal suite's source probes) |

The prior study branch never reached the remote; the local tree carried the
freeze commit, which was cherry-picked here. Post-freeze deltas, all in
`validity/` and all pre-measurement: the `StudyQueryCase`/driver-contract fix
and protocol Amendment 1 (PROTOCOL.md), the `call_order` control, the
metadata-audit copy under `audit/`, and the real-audio provenance under
`real-audio/`.

## Environment

| component | version |
| --- | --- |
| Python | 3.8.20 (venv `/tmp/w1py38`, created with uv; matches CALIBRATION.md's recorded stack) |
| numpy / scipy / matplotlib | 1.24.4 / 1.10.1 / 3.7.5 |
| editable installs | `python/cogbench`, `benchmarks/week1` (`cogworks-week1-audio-benchmark 0.1.0`), `examples/week1-audio-submission` (`cogworks-week1-audio-submission 0.1.0`) |

## Check commands and results (run 2026-10-10)

```
git submodule update --init
/tmp/w1py38/bin/python -m unittest discover -s apps/runner-modal/tests -p 'test_*.py'
/tmp/w1py38/bin/python -m unittest discover -s benchmarks/week1/tests -t benchmarks/week1 -p 'test_*.py'
```

- runner-modal: **Ran 628 tests — OK (skipped=46)**, 45.9 s. First run before
  `git submodule update --init` and before pip existed in the uv venv failed
  with 4 environment errors (missing week2/week3 source trees, no `pip`
  module); all four cleared by the two environment fixes, no code change.
- week1 benchmark: **Ran 64 tests — OK (skipped=2)**, 327.6 s, zero errors.
  Two earlier attempts: the first failed with 7 loader errors (the venv had no
  `pytest`, which the test modules import for fixtures); after installing it,
  2 modules still failed with `attempted relative import with no known parent
  package` under plain discovery. Both cleared by re-running discovery with
  the top-level directory set (`-t benchmarks/week1`), which imports the test
  modules as the `tests` package — an invocation detail, not a code change.

## Executable variant commands

Study arms (all variants, one arm per command; see PROTOCOL.md):

```
cd examples/week1-audio-submission
/tmp/w1py38/bin/python validity/run_study.py --arm official   --tier evaluation --jobs 4
/tmp/w1py38/bin/python validity/run_study.py --arm seeds      --tier evaluation
/tmp/w1py38/bin/python validity/run_study.py --arm probe
/tmp/w1py38/bin/python validity/run_study.py --arm ambiguity
/tmp/w1py38/bin/python validity/run_study.py --arm real       --real-dir /home/user/work/real-audio-arm/
```

Single-variant invocation (same entry point the study uses):

```
/tmp/w1py38/bin/python validity/run_study.py --arm official --tier test --variants tuned
```

CALIBRATION.md's reproduce commands (unmodified, against the same venv):

```
/tmp/w1py38/bin/python calibrate.py --tier test       --seeds 3 --json /tmp/w1_final_test.json
/tmp/w1py38/bin/python calibrate.py --tier evaluation --seeds 3 --json /tmp/w1_final_eval.json
/tmp/w1py38/bin/python probe_grid.py --tier evaluation --queries 3
```
