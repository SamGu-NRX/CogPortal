## runner.py

`runner.py` is the execution engine. `execute()` is its front door, and the
CLI's `test` and `run` commands both go through it. The module holds no
state and touches no network: cases come from the loaded benchmark plugin,
predictions from the loaded submission, and the only files it reads are
already on disk. Every contract violation raises `ContractError`, whose
message the CLI prints unchanged, so each one names what happened and one
next action.

### Two execution paths, one front door

`execute()` reads the benchmark's `contract_version` and routes. Both paths
time the run, stamp SDK, plugin, and repository state (via
`project.repository_state`) onto a `LocalReport`, and walk the same progress
phases. The shape of the work is different:

| | v1 (`cogworks.submissions.v1`) | v2 (`cogworks.submissions.v2`) |
| --- | --- | --- |
| Who owns the loop | The engine: it asks the plugin for `public_cases()` and calls the adapter once with every input. | The plugin: it gets `load_cases(tier)`, the submission's raw factory, and a built model, and runs the scenarios itself. |
| Smoke (`cogworks test`) | Keeps only the first case, enough to prove the wiring. | The tier becomes `test` instead of `evaluation`; the plugin decides what that covers. |
| Scoring | Plugin returns finished `Metric` objects; the engine rejects anything else in the list. | Plugin returns a plain dict of numbers; the engine wraps each one with `_metric()` and requires `primary_metric` to be present. |
| Model | None; the adapter brings whatever it needs. | The engine builds a FaceNet model (`_facenet_model`) unless the plugin overrides it with a `model_factory` attribute. |
| Diagnostics | Whatever `score()` returns alongside the metrics. | The plugin's `last_diagnostics` attribute, when it reports one. |

The v2 path passes the submission through as a factory without calling it.
The plugin decides when and how many times to instantiate, which is what
lets a benchmark manage per-scenario state (an enrollment database, a
clustering model) that a one-shot `predict` cannot express.

A v2 plugin can also shape metric presentation with `metric_labels` and
`lower_is_better`. Week 2's plugin predates those attributes, so the engine
carries its defaults: the FaceNet builder, the `_V2_LABELS` display labels,
and an empty `lower_is_better`, which reports every metric as
higher-is-better. Metric values render at the 3-decimal precision
`_metric()` sets.

### The progress-callback contract

Every long step reports progress before it works, so a slow run shows a
phase instead of silence. In order: `preparing` (only `execute_installed`,
before discovery), `contract_check`, `evaluating`, `scoring`. The run ends
in a report or an exception, never in a progress phase.

Callbacks are sniffed, not declared. `_accepts_progress_counts` inspects
the callback's signature and passes `(phase, current, total)` when it takes
`*args` or at least three parameters; anything else gets phase-only calls.
That keeps a plain `phases.append` working as a progress target, and a
callback whose signature `inspect` cannot read gets phase-only calls too.
`evaluating` is emitted twice on purpose: once at 0 of N so the total is
known before any work happens, and once at N of N when the last case has
run.

### The Week 2 model-cache verification story

The Week 2 benchmark scores against one exact FaceNet checkpoint, so a
truncated or corrupted download would quietly change every score.
`model-lock.json` ships inside the installed `facial_recognition_benchmark`
package and records the checkpoint's name, size, and sha256.

`model_cache_status()` checks the story before trusting it: find the file
in `checkpoints/` under `TORCH_HOME` (default `~/.cache/torch`, where
PyTorch caches downloaded checkpoints), compare its size, then its sha256.
Size first because it is free; the hash has to read the whole file. The
result is a plain dict, `{'ready': bool, 'path': str, 'message': str}`, and
every not-ready result says which check failed, so `cogworks check` can
report what is actually wrong instead of sending a student to re-download
something that was fine. (`cogworks check` asks the plugin's own
`model_cache_status` attribute first and falls back to this function, the
same override pattern as the run path.)

The module refuses to score against a model it cannot verify: a missing or
unparsable lock raises `ContractError` ("Reinstall the benchmark package").
Reading the lock goes through `importlib.resources`, with an `open_text`
fallback for Python 3.8, where `importlib.resources.files` does not exist.

### Failure shape

The v2 path wraps the two steps that can run arbitrary code. If case
preparation fails, the error becomes `ContractError` ("Benchmark data could
not be prepared: ..."). If adapter execution fails, it becomes "Student
adapter execution failed: ...", unless the plugin raised `ContractError`
itself, which keeps its own message. Either way the run ends as a
categorized failure with the reason attached, instead of a traceback.
