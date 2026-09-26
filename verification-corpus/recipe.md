# Corpus acceptance recipe

This records the preparation phase. The later authorized execution and corrections are in [execution/report.md](execution/report.md), with the measured 20-case matrix beside it.

For the manager and the T3 operator deciding what can be measured now and what must be supplied first. Inspected at portal commit `37b1972bbe17027256e1f5d9cf150e74193083e3` on September 10. No student code, binding search, scored case, data download, hosted attempt, or installation ran during this phase. There is no measured success ratio.

## Counts and acceptance contract

The clone manifest defines 13 repositories. Rutvim contains three separate weeks, yielding 15 week-projects, five per week. The current package entry points define **20 intended project/benchmark pairs**: five Audio v1, five Vision Clustering v2, five Vision Recognition v2, and five Language v1. Recognition and Clustering measure different behavior, so neither is a duplicate. Keep all 20 rows, even when a benchmark cannot discover a submission.

At this pin, RecognitionBenchmark has no `discovery()` or `submission_from_discovery()`. ClusteringBenchmark does. None of the 13 repositories has a tracked `submission.py` or `benchmark_adapter.py`; this also holds for nested files. The five Recognition pairs therefore have a source-established unsupported automatic-binding path. A future CLI refusal confirms that path, not a missing recognition algorithm in the student's code. Do not add instructor adapters to inflate coverage. Sources: `source/week2/facial_recognition_benchmark/plugins.py:23`, `:119`, `:256`; `source/portal/python/cogbench/src/cogbench/cli.py:337`; tracked-file inventory.

Record each dimension separately for each pair and tier:

| Dimension | Evidence and meaning |
| --- | --- |
| Input available | The named commit and project directory exist. Record absent files, unresolved Git LFS pointers, dependencies and benchmark data separately. Availability is not an import result. |
| Importing | Preserve the discovery survey's loaded/read and skipped modules with reasons. A package import passing does not show that every student module imported. Recognition has no discovery survey at this pin, so its import status is not measured. |
| Discovery/binding | Preserve the full `checks.discovery`, selected root, chains, branches, missing branches, weights, verdict and `submissionSource`. Distinguish a complete binding, a scoreable partial binding, a refused binding and unavailable discovery. `submissionLoadable=true` is not full scoring. |
| Valid refusal | The tool emits a reason supported by the source or prerequisite evidence and invents no score. Tag the cause as unsupported benchmark binding, missing student feature/artifact, missing evaluator dependency/data, execution fault, or unresolved cause. A refusal may be correct behavior while remaining an unscored pair. |
| Partial scoring | A valid result measures a proper subset of required components. Retain the subset, missing branches, actual primary key, withheld metrics and reasons. Language text-only or text-plus-retrieval results stay partial, even if the CLI exits zero. |
| Full scoring | The selected public tier completes all required components with valid outputs and finite scorer metrics. Preserve any failed scenario and withhold this label when a metric merely averages error outputs. A low genuine score can still be a full measurement; no score threshold is a coverage rule. |

Language requires text, image projection, database preparation and search. A missing image branch withholds overall/retrieval/search and makes `text_mrr` primary; a missing search branch withholds overall/search and makes retrieval primary. Preserve the scorer's decision, including chance floors. Do not replace withheld metrics with zero or rank a text result beside an overall result. Sources: Week 3 `plugins.py:338`, `:377`, `:490`, `:599`.

For Audio, count successful/failed enrollments and query outputs by kind, and retain the scorer's diagnostics. A single-ID matcher can legitimately be scored without claiming it returns a ranked list. Vision Clustering includes a scored partition and diagnostic repetitions across seeds; diagnostics are not extra projects. Recognition requires known identification, unknown rejection and post-enrollment behavior. Do not equate a written LocalReport with complete execution.

Report counts by benchmark out of five and by pair out of 20. The primary project count out of 15 requires every intended pair for that project to be fully measured. A separate "at least one component measured" count may be useful, but must keep that label. Do not collapse test-tier and evaluation-tier counts. No whole-repository success fraction out of 13 is needed.

## Pinned code and retained inventory

`source/portal/` contains the inspected SDK, runner tools and selected manifests/docs from the exact portal commit. The three benchmark source directories were read with `git show` from these exact gitlinks, without updating any submodule:

| Source | Commit | Public manifests |
| --- | --- | --- |
| `source/week1/` | `b590638a4c6d7b0e840723f5d4d38b1a90070a62` | `week1-test-v1`, `week1-evaluation-v1` |
| `source/week2/` | `c177cf23cdd4f8dbe55401a2eb4bada4c64d37c2` | `celeba-public-test-v1`, `celeba-public-evaluation-v1` |
| `source/week3/` | `b166f5c15e950baccc3785839cdcc660ffe01bb4` | `language-search-public-test-v1`, `language-search-public-evaluation-v1` |

`inventory.json` records every absolute repository path, full commit, current dirty status and each Git LFS pointer. `cases.json` and `cases.tsv` contain the exact 20 pairs, their project IDs and working subdirectories. `environment-metadata.json` records installed distribution versions without importing the distributions. `source-sha256.json` fingerprints the frozen code and manifests.

The original cache root is `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos`. The integration checkout's `.cache/student-repos` does not exist. Several originals contain changes, including CoggurtFilter's `db.json`, Asterisk's audio arrays and Vision database, and tracked bytecode in KrazeeCoder. Do not copy these working files into a clean-commit measurement. No tracked symlinks were found in the 13 commits.

## Prerequisites actually present

| Environment/data | Current inspection | Consequence |
| --- | --- | --- |
| Local 3.11 | `/Users/samgu/BWSI/2026/CogPortal/.venv-test/bin/python`, verified interpreter 3.11.15. All four v2 benchmark registrations, SDK 0.2.0 and all declared track module files are present. Relevant versions include numpy 1.24.4, scipy 1.10.1, librosa 0.11.0, numba 0.58.1, gensim 4.3.3, torch 2.2.2, torchvision 0.17.2, mygrad 2.2.0 and mynn 0.9.4. | Selected for the initial local matrix. Installed metadata and files are verified; binary imports and runtime compatibility are not. Frozen PYTHONPATH selects the exact inspected SDK and plugin implementations. |
| Audio canonical interpreter | `/opt/anaconda3/envs/cogworks_week1/bin/python` is 3.8.20. Existing environment has older numpy 1.24.3, librosa 0.10.2.post1, llvmlite 0.41.0, matplotlib 3.7.2, platformdirs 3.10.0 and no Audio v2 registration. | Do not call this the pinned hosted environment or install into it. A disposable environment matching `environment.py:106` is needed for the canonical repeat. |
| Language canonical interpreter | `/opt/anaconda3/envs/week3-bench/bin/python` is 3.8.20 and has Language v2, gensim 4.3.3, numpy 1.24.4, scipy 1.10.1, mygrad and mynn. It also has an instructor submission entry point and older SDK metadata. | A later canonical repeat must use frozen SDK/plugin source and complete the track dependency check. The current CLI refuses installed reference submissions, but retain `submissionSource` to prove what ran. Do not silently switch interpreters within one aggregate. |
| Other environments | `.venv` is Python 3.14 with legacy v1 packages. `.venv-deploy` includes instructor Audio/Vision submissions. `cw2` is Python 3.8 with Vision reference entries. | None is the selected initial measurement environment. |
| Audio inputs | Both public manifests are in the pinned package. Signals are generated and checked against hashes. Test has 8 enrollment songs and 68 queries; evaluation has 30 enrollment songs and 252 queries. | No external benchmark dataset is required. Synthesis and student execution remain untested in this phase. |
| Vision images | `/Users/samgu/Library/Caches/cogworks/week2-vision/` exists, but the full cogworks cache contains zero files. Test requires 32 selected images; evaluation requires 83. | Public data must be materialized and pixel-verified. Clustering's small discovery fixture can still be attempted independently; scoring is blocked on images. |
| Vision FaceNet | `/Users/samgu/.cache/torch/checkpoints/20180402-114759-vggface2.pt`, 111898327 bytes, SHA256 `281cebca8662831adb987a874bdcb36e73f5b1c6dc5ee5878f305e985625d99b`. | Exact match to `model-lock.json`. No checkpoint download needed. Model construction is not yet tested. |
| Language inputs | `/Users/samgu/Library/Caches/cogworks-language-search/` and `/Users/samgu/Library/Caches/cog_data/` are empty. CogFinder and Asterisk each contain three 133/134-byte Git LFS pointers, not the caption/descriptor/GloVe data. No corresponding local LFS objects were found. | Need the three pinned files totaling 934754997 bytes plus the derived GloVe cache. Both discovery and scoring depend on them. This is an evaluator prerequisite, not a student failure. |
| Language weights | Lashika commits `data/W_embed.npy`; Bagel commits several model pickles. Rutvim commits a GloVe `.kv` but lacks its `.vectors.npy` sidecar in tracked files. | Let the pinned resolver identify usable trained weights and ambiguities. GloVe is a resource, not trained image-projection weights. Do not train a model or copy another team's weights to make a case full. |

The hosted student interpreter is 3.8.20 for Audio/Language and 3.11 for Vision according to the pinned CLI and runner. Week 2's model-lock file still lists Python 3.8.20; preserve this disagreement in the environment record rather than calling local 3.11 Linux-hosted parity. The selected run measures macOS local behavior.

## Exact operator commands

`run-case.sh` is a small evidence wrapper around the existing CLI. It creates a separate local shared clone per pair, checks out the recorded commit, gives the copy the recorded GitHub origin, and preserves stdout, stderr, exit status, timestamps, Git status and `.cogbench` files. It never edits the original caches or integrates product code. Local shared clones depend on the source Git object stores remaining present during the run.

The wrapper uses the frozen source and the selected 3.11 interpreter. `check` retains the discovery result; `test` scores the public test tier; `run` scores the public evaluation tier. `check` and scoring keep the CLI's normal memo behavior in the case copy. Record that the first check is cold and later phases can reuse its binding. A requested cold repeat needs a new run directory and copy, not deletion of an original's memo.

From this directory, one case can be run as follows after the execution phase is authorized:

```sh
bash run-case.sh w1-g4-audio check
bash run-case.sh w1-g4-audio test
bash run-case.sh w1-g4-audio run
```

Replace the ID with the exact ID in `cases.tsv`. For example, `w2-g1-cluster` and `w2-g1-recognize` are distinct pairs; `w3-g1-language` runs from the isolated copy's `Week3` directory. All other single-week cases start at repository root. Capture the resolver-selected root as evidence, especially for repositories with nested code.

Each command creates `local311/results/<case>/<phase>/`. Existing output directories cause a refusal to overwrite. A missing data preflight writes `blocked-prerequisite` and starts no student command. The script does not label a parsed JSON object as a success. Its JSON parser check is only a check that the evidence is readable.

Before any execution, the operator should verify package imports against frozen paths and retain that output:

```sh
EVIDENCE=/Users/samgu/.codex/worktrees/dd61/CogPortal/verification-corpus
PY=/Users/samgu/BWSI/2026/CogPortal/.venv-test/bin/python
CODEPATH="$EVIDENCE/source/portal/python/cogbench/src:$EVIDENCE/source/week1:$EVIDENCE/source/week2:$EVIDENCE/source/week3"
PYTHONPATH="$CODEPATH" "$PY" -B -c 'import sys,cogbench,audio_identification_benchmark,facial_recognition_benchmark,language_search_benchmark; print(sys.version); print(cogbench.__file__); print(audio_identification_benchmark.__file__); print(facial_recognition_benchmark.__file__); print(language_search_benchmark.__file__)'
```

No data preparation commands below were executed. They download public inputs and build caches, so they belong to the next explicitly scoped data-preparation phase. They use the existing benchmark functions; they do not require the private official-data materializers.

```sh
# With EVIDENCE, PY and CODEPATH defined as above:
PYTHONPATH="$CODEPATH" "$PY" -B -c 'from facial_recognition_benchmark.datasets import load_manifest,materialize_manifest; print(materialize_manifest(load_manifest("test"))); print(materialize_manifest(load_manifest("evaluation")))'

COGWORKS_LANGUAGE_DATA="$EVIDENCE/data/language" PYTHONPATH="$CODEPATH" "$PY" -B -c 'from language_search_benchmark.datasets import build_resources; r=build_resources(download=True,build_kv=True); print(r.captions_path); print(r.descriptors_path); print(r.glove_path); print(r.glove_kv_path)'
```

Vision uses the pinned `flwrlabs/celeba` revision `2d738f56e0e7f925ea36ae7c808ea925264aacec`, streaming only the manifest-selected rows through the existing materializer. It validates decoded pixels and identity hashes. Language uses the exact size/SHA256 pins in its manifest; verify the derived `.kv` and `.kv.vectors.npy` together before discovery. Do not substitute the incomplete `.kv` from Rutvim. The wrapper passes `COGWORKS_LANGUAGE_DATA` to every case so the shared resource location is explicit.

For a canonical 3.8 repeat, create a separate disposable environment from the existing 3.8.20 interpreter, install the track requirements declared in pinned `environment.py`, and install the pinned SDK/plugin packages there. Keep its outputs in a separately named run directory and retain a complete dependency lock. Do not modify the four pre-existing environments. This phase has not established an offline wheel set or executed that setup, so the canonical repeat is a prerequisite task, not an immediately verified command path. Context7 was attempted for setup documentation and returned a monthly-quota error; the executable CLI recipe above is derived from the pinned local source.

## Finite batch and retained result

1. Complete and retain the package-origin preflight. Run one cold check per pair, 20 total, in case order. Execute sequentially so four scientific runtimes do not compete for memory. Checks use the CLI's existing 300-second discovery child limit and 3 GiB address-space limit where the OS enforces it. Imports have 30-second limits and candidate calls 10-second limits. Do not add a second timeout that changes those outcomes.
2. Audit each check's JSON and stderr. Keep unsupported Recognition and unavailable Language rows. A nonzero check with missing cache is not evidence that the student's code cannot bind. After common data is prepared, retry prerequisite-blocked rows into new attempt directories. Do not retry a valid feature refusal automatically.
3. Run one test-tier measurement for every pair with a scoreable full or partial binding, after its data preflight passes. Keep the others as explicit unscored/refused/blocked rows. Partial Language bindings should run so their valid caption or retrieval score is retained.
4. Inspect outputs and diagnostics, then run one evaluation-tier measurement for each scoreable pair. Do not gate on score magnitude. Keep a test error, evaluation error or operator interruption separate from a supported feature refusal.
5. Retain one row per case, per tier, including prerequisite state, import survey, binding coverage, refusal category/reason, command exit code, output validity, primary metric key/value, measured components, withheld metrics, diagnostic errors, source refs, input manifest hash and evidence directory. Count full/partial/refused/blocked/crashed/interrupted separately. No aggregate is allowed while a pair is silently absent.

The local CLI deliberately gives a scored run no overall time or memory budget (`cli.py:857`). Therefore a finite case list is not a promised finite wall-clock duration. Operate one scored case at a time and collect its result before starting another; if an operator stops a stalled run, preserve it as interrupted. Do not use the discovery limit for scoring. Hosted job limits are a different policy and cannot be claimed by this local measurement. No Modal or hosted calls are part of this recipe.

## Why the older tools are insufficient

- `tools/corpus_bindings.py` has ten rows, only Audio and Clustering, emits bindings rather than scores, does not retain complete per-case logs, and ignores `_sub`. Its subprocess has no outer timeout. Extending its row list alone would still not measure full scoring.
- `.cache/tools/w1_one.py`, `w2_one.py`, `w3_one.py` delete an original cache's `resolved.json`, call student code without the CLI's complete process boundary, print selected rounded metrics and do not preserve full reports. Do not execute them against the originals.
- `apps/runner-modal/tools/diagnose_corpus.py` compares Audio synthesis primitives on the local machine and a new Modal sandbox. It is not a student compatibility sweep and would make a hosted call.
- `run_week3_local_parity.py` requires 3.8, assumes an installed submission, writes shared `/tmp/cog-*` files, imposes 900 seconds and expects overall plus all components. It cannot represent the accepted partial-scoring policy or all course tracks.
- The official materializers write private benchmark bundles and replace an existing target. Public corpus acceptance needs neither them nor private evaluation data.
- `docs/design/discovery-v2-ground-truth.json` contains ten hand-investigated cases across all three weeks, not a current automatic result matrix. Its comments include pre-implementation gaps, manually supplied glue and historical training experiments. Use it to explain a discrepancy only after a current case result exists.

The existing `check/test/run --json` commands can measure every intended pair or expose why it is unavailable. The smallest addition is the prepared case manifest and per-command evidence wrapper, not another evaluator. Measuring Recognition automatically at this pin would require product discovery support, or explicitly approved student-owned adapters; that is a separate implementation decision for T3, not a measurement workaround.

## Verification limits

The 20-case inventory and 15-project count were checked from the pinned clone manifest. The source exports and manifest hashes are retained. `bash -n run-case.sh` passes. Python interpreter versions were queried with isolated stdlib-only invocations. Package metadata, paths, repository revisions/dirty states, LFS pointers and checkpoint bytes were read without importing student modules. The wrapper has not been executed against a student case. Its first authorized run is still needed to prove runtime behavior.

The Helium tab remains available for the next UI candidate. No browser interaction occurred in this corpus-preparation phase.
