# Corpus cold-check results

All 20 planned checks completed sequentially on September 10, using frozen portal commit `37b1972bbe17027256e1f5d9cf150e74193083e3`, its three pinned benchmark revisions, clean copies of the recorded student commits, and the existing macOS Python 3.11.15 environment. Public inputs were downloaded and validated first. No `test` or `run` scoring command was executed.

The complete per-case matrix is [binding-matrix.md](binding-matrix.md). [binding-results.json](binding-results.json) retains selected roots, import/skip lists, binding chains, missing branches, weights, candidate errors, cache status, elapsed times and absolute evidence paths. Every case has its original CLI JSON and stderr under `../local311/results/<case>/check/`.

| Checks | Full binding | Partial binding | Supported refusal | Prerequisite failure | Execution fault | Not measured |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Audio, five primary projects | 4 | 0 | 1 | 0 | 0 | 0 |
| Clustering, five primary projects | 2 | 0 | 1 | 0 | 2 | 0 |
| Language, five primary projects | 0 | 1 | 0 | 0 | 4 | 0 |
| Primary week-project checks, 15 total | 6 | 1 | 2 | 0 | 6 | 0 |
| Recognition checks, separately, five total | 0 | 0 | 5 | 0 | 0 | 0 |
| All intended benchmark pairs, 20 total | 6 | 1 | 7 | 0 | 6 | 0 |

These are binding outcomes. The seven scoreable bindings have not been scored on either public tier. The SDK's raw discovery verdict sometimes says `status: scored`; that label only reflects its discovery fixture here. No scored-coverage fraction follows from this run.

Sam's historical 13/15 description remains a separate, undefined claim. The 15 primary project checks above provide a clearly stated denominator for a new measurement; they do not establish the old claim's success rule, environment or local state. The strict every-intended-benchmark definition used in the earlier recipe is not a comparison to that historical claim.

## Findings and next actions

- Five checks aborted in macOS Objective-C initialization after `fork`: CoggurtFilter Clustering, and Rutvim, CogFinder, Lashika and Bagel Language. Each stderr records `+[NSCharacterSet initialize]` and the runtime's refusal to initialize safely in the fork child. The CLI retained a JSON `crashed` result. These are local execution faults, not evidence that the student algorithms or trained weights are absent. The platform's boundary calls `os.fork()` at frozen `source/portal/python/cogbench/src/cogbench/isolate.py:421`; no safety-disable flag or retry was used. T3 should inspect the macOS process-start path and rerun these five cold checks after a safe correction, preserving the existing limits. An exact triggering library or student function is not established by the fatal stderr alone.
- Asterisk Clustering reported `timed_out`, but its retained timestamps are 09:50:01 to 09:51:02 UTC, only 61 seconds. The configured discovery wall-clock limit is 300 seconds, and this wrapper adds none. `_describe_death` maps SIGKILL inside a timed boundary to `TIMED_OUT` at `isolate.py:361`; `_check` emits only the status and omits the detailed death reason at `cli.py:514`. That logic can mistake another kill for an expired timer. The actual death signal/cause was not retained, so neither a 300-second timeout nor an OOM is established. Correct my earlier progress message accordingly. The smallest next diagnostic change is to preserve the actual death detail/signal and whether the parent alarm fired, then repeat this one case separately.
- All five Recognition checks refused with no declaration and no discovery record. At the frozen pin, `RecognitionBenchmark` has no discovery method, while `ClusteringBenchmark` supplies one. No tracked student case declares `submission.py` or `benchmark_adapter.py`. This is a missing platform discovery capability. It is not evidence the students omitted recognition. Keep the rows; T3 owns any product support decision. Do not add instructor adapters to change the count.
- Asterisk Language produced a partial binding: `text_embedder (CaptionVectorizer)` for text and `database.ImageDatabase` for prepare, with image and search missing and no weights used. The check exited zero and its headline said ready to score, so reading only exit code or headline would overstate coverage. Preserve `missing.image` and `missing.search`. The next scoring phase must retain the scorer's withheld metrics and actual primary key; this check produced no caption, retrieval or overall score.
- Audio Asterisk refused after finding fingerprinting but no accepted enrollment/query pair. Rutvim Clustering refused at the descriptors input. These are supported reports of the binding search's result, not proof that no algorithm exists anywhere in either repository. Rutvim's survey also records a skipped `app` import because webcolors is absent. Its attempted graph implementation imports `model` from `pyexpat` and calls `model.detect`, matching one concrete candidate error. Keep both the dependency skip and candidate errors instead of turning them into a broad missing-feature claim.

The six full bindings are Audio Rutvim, Cog-gurts, KrazeeCoder and carti4ce, plus Clustering Lashika and Bagel. All seven successful full/partial bindings report `recalled: false`, `hashRandomization: false`, and `hashSeed: "0"`. No case used an installed instructor submission entry point.

## Inputs and environment

`package-origins.json` verifies that the SDK and all three benchmark packages were imported from the frozen source export before the first student check. All four v2 benchmark registrations were present. The dependency metadata is retained in `../environment-metadata.json`; no original environment was installed into or modified by a command in this phase.

| Component | Identity |
| --- | --- |
| Portal/SDK source | `37b1972bbe17027256e1f5d9cf150e74193083e3` |
| Audio benchmark | `b590638a4c6d7b0e840723f5d4d38b1a90070a62`, Audio v1 |
| Vision benchmark | `c177cf23cdd4f8dbe55401a2eb4bada4c64d37c2`, Clustering v2 and Recognition v2 |
| Language benchmark | `b166f5c15e950baccc3785839cdcc660ffe01bb4`, Language v1 |
| Interpreter | `/Users/samgu/BWSI/2026/CogPortal/.venv-test/bin/python`, 3.11.15, macOS arm64 |
| Vision data | `../data/vision/week2-vision/v1/celeba-public-test-v1` and `celeba-public-evaluation-v1`, 32 and 83 images; `flwrlabs/celeba` revision `2d738f56e0e7f925ea36ae7c808ea925264aacec` |
| Language data | `../data/language/`, captions 66782097 bytes, descriptors 174540061 bytes, GloVe text 693432839 bytes; all match the pinned manifest SHA256 values |
| Derived GloVe | `.kv` 11228170 bytes and `.kv.vectors.npy` 320000128 bytes, built by the pinned resource loader from the validated text file |
| FaceNet checkpoint | Existing `/Users/samgu/.cache/torch/checkpoints/20180402-114759-vggface2.pt`; SHA256 remains `281cebca8662831adb987a874bdcb36e73f5b1c6dc5ee5878f305e985625d99b` |

`data-preparation.log` records both Vision tiers validating successfully and Language artifact preparation completing successfully. `data-identities.json` fingerprints all 123 materialized files and the manifests/code hashes are in `../source-sha256.json`. The materializers used public data only, with a task-owned Hugging Face cache and no inherited HF token. Existing model weights were read, not replaced.

The standard user Vision/Language caches were empty before preparation. The apparent large files in CogFinder and Asterisk were Git LFS pointers. The frozen resource loaders now use the task cache; the original pointer files remain untouched. Clustering discovery itself needs its test-tier images, correcting the earlier recipe's claim that it could proceed independently of data preparation.

This is local311 verification, not Linux hosted or Python 3.8 parity. Audio and Language's canonical hosted student interpreter is 3.8.20. The active T3 repair candidate was not an input to these checks; its relevant source still needs comparison before claiming current-candidate parity.

## Wrapper verification and corrections

The wrapper was syntax-checked and first exercised on the known KrazeeCoder Audio case. It selected the correct GitHub repository, commit, frozen package origins and Audio benchmark, returned valid JSON with a cold full binding, and left the isolated case's tracked Git status clean. That check is one of the 20, not an extra warm result.

One necessary wrapper adjustment routes Vision data through its existing optional `cache_root` parameters. `cli-with-cache.py` applies those parameters to `load_cases` and `cache_status` before invoking the unchanged CLI. It changes storage location only. The data preflight now passes the same cache root. Language uses the benchmark's existing `COGWORKS_LANGUAGE_DATA` override. Matplotlib, Numba and Hugging Face caches are task-owned too. The original recipe's default-cache invocation would not have used the task-owned Vision data.

The wrapper preserves stdout, stderr, exit code, command/cwd, source/student revisions, start/end timestamps, before/after Git status and the case's `.cogbench` evidence. All 20 stdout files parsed as JSON; all 20 attempts finished with exit 0 or 2. The frozen CLI retains its existing process, import and candidate-call limits. No scoring timeout, limit increase, safety-disable flag, hand adapter or product-source change was introduced.

## As-found state and preservation

Read [dirty-cache-report.md](dirty-cache-report.md) and [dirty-cache-classification.json](dirty-cache-classification.json) for every path, hash and classification. The 75 changed paths are 57 generated bytecode files, 16 generated audio arrays and two generated databases. No changed authored Python or trained-weight file was found.

The 16 audio arrays preserve shape but widen int32 to int64. Asterisk Vision's generated database is empty in the as-found cache, compared with 410832 committed bytes, and its source loads that file at import. CoggurtFilter's generated JSON database grew from 33 to 67 profiles. These changes can affect behavior even without a code edit. A clean-commit run is therefore not automatically the local state Sam remembers. If useful after the process faults are resolved, a later isolated as-found comparison should overlay only these hashed generated artifacts into separately labeled copies.

`preservation-check.json` confirms that all 75 as-found changed-file hashes remained the same through this phase, all 229 frozen source-file hashes still match, the original FaceNet checkpoint hash is unchanged, and no saved scoring report exists in the case copies. No product files, original student caches, auth/config files or browser tabs were intentionally changed. The Helium task tab remains untouched for the next UI candidate.

Stop here. Review the process faults and unsupported Recognition interface before selecting the next scoring phase. The data is ready, the raw 20-case evidence is retained, and the original checks should not be silently replaced by later retries.
