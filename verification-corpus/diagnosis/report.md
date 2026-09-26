# Process-failure diagnosis

For the manager and T3 repair owner. The mechanism is now reproduced on frozen `37b1972`; the original 20 rows remain unchanged. Only one representative case per failure category was repeated, in separate clean copies. No product source, limits, proxy policy or macOS fork-safety settings were changed.

## Findings

1. **The Language abort is a cold macOS proxy lookup inside the fork child.** The instrumented Lashika Language check forked once, at SDK `isolate.py:421`, and its child died with SIGABRT, signal 6, after about 2.7 seconds. No parent alarm fired. The retained Python fatal stack pinpoints `train.py:24 prep_data` → `cogworks_data.language.get_data_path:53` → Pooch fetch → Requests proxy resolution → `urllib.request.proxy_bypass_macosx_sysconf:2664` → `_scproxy._get_proxy_settings`. The last operation invokes macOS SystemConfiguration. This is the concrete trigger for this representative case, not a guessed model-loading or missing-weight failure. Evidence: `w3-g4-language/fatal-stack.txt`, `events.jsonl`, `stderr.log` and `command.json`.

2. **The resolver reaches that network path despite already having the required artifact.** `train.py:7` imports the course loader and its `prep_data` function later requests `resnet18_features.pkl`. That exact validated file is in the task's Language cache. The course package does not honor `COGWORKS_LANGUAGE_DATA`; its function delegates to its separate Pooch cache. The SDK's resource redirection is scoped to import: `discover.py:1951` enters it and `:2065` leaves it, then `resolve.py:744` probes candidate functions. `_patch_course_loader` at `discover.py:1781` only runs after a recognized import failure, through `install`, and cannot cover a loader first used at call time with an already-captured `from ... import get_data_path` alias. Merely extending `leave()` is therefore insufficient. The precise resource repair target is the validated course-file handoff across imports **and** fit/probe calls, without changing student algorithms or silently fetching another copy.

3. **Asterisk's representative repeat hit a CPU signal, not a wall-clock alarm.** The Clustering child exited with raw wait status 24, SIGXCPU, after about 37.7 seconds inside the boundary. No parent alarm event or pickle exception occurred. The configured `_apply_limits` sets RLIMIT_CPU to 300 seconds soft / 305 hard at `isolate.py:262`; CPU limits need not equal elapsed time when native work uses multiple threads. Actual accumulated CPU time was not collected, so do not claim it was measured at exactly 300 seconds. This repeat establishes SIGXCPU, not OOM or SIGKILL. The old 61-second row did not retain its signal, so it remains ambiguous rather than being rewritten from this new result. Evidence: `w2-g2-cluster/events.jsonl`, `stdout.json`, `command.json`.

4. **There is also an independently reproduced false-timeout bug.** A standalone child deliberately sent SIGKILL to its own PID. It died within milliseconds, the parent alarm never fired, and the unchanged SDK returned `timed_out` with "stopped after taking longer than the time allowed". At `isolate.py:433`, `alarm` means an alarm can be armed; at `:467` it is passed as `timed` to `_describe_death`. Lines `:362–374` consequently treat any SIGKILL as an expired deadline. The control flow also loses whether `_read_payload` returned EOF/invalid data or raised `_Alarm`, and always requests cleanup kills before interpreting death. Evidence: `self-kill/events.jsonl` and `stdout.json`. This proves the generic classification defect but does not make it the cause of Asterisk's SIGXCPU repeat.

5. **The CLI drops useful death detail.** `_read_repository` returns status and detail, but `_check` at `cli.py:514–519` puts only the status into JSON `submissionError`. That is why SIGXCPU looked like an unexplained short timeout in the original matrix. Preserve the detail, actual signal, configured limits and observed alarm-expiration state in the existing check result. Keep an unexplained external SIGKILL as cause unknown; never infer OOM from it.

All SDK file references above resolve under `../source/portal/python/cogbench/src/cogbench/`. Student references resolve under `cases/w3-g4-language/`. The exact installed urllib and package paths are in the fatal stack. These are separate diagnostic results, not replacement corpus rows.

## Where work runs

The parent imports the CLI/plugin packages and performs cache checks, then `cli._read_repository:451` calls the generic `run_isolated`. The child establishes its session, working directory, stdin EOF and limits at `isolate._child:284–300`. It then builds the discovery spec, imports the student modules and probes candidates. The failing SystemConfiguration call happens during `_fits_of → _fit → probe_sources → _call`, after module import, as the fatal stack shows.

Instrumentation observed exactly one Python `os.fork` call in each representative check. It was the outer CLI boundary. No nested Python probe fork occurred in either trace. Git/helper subprocess waits also appear, but they are not evidence of a second SDK discovery fork. The SDK's separate `discover.survey:2374` can call `run_isolated` from other entry points; it was not on these traces. Python thread enumeration at the outer fork showed only MainThread. This does not count native library threads or prove the process is safe to fork. Import timers are created later in the child by `discover._deadline:876`.

## Minimal comparison and repair choice

The no-network `proxy-probe.py` calls only `urllib.request.proxy_bypass("example.invalid")`. It makes no HTTP request and records no proxy settings. Each mode starts from a fresh interpreter; the fork modes keep the SDK's default isolation limits.

| Environment | Cold SDK fork | Parent proxy warm-up, then SDK fork | Fresh interpreter subprocess |
| --- | --- | --- | --- |
| macOS arm64, Python 3.11.15, existing `.venv-test` | SIGABRT / same NSCharacterSet error | Completed | Completed |
| macOS arm64, Python 3.8.20, existing `week3-bench` | SIGABRT / same NSCharacterSet error | Not tested | Completed |

Results live in `proxy-probe/` and `proxy-probe-py38/`. No student case was rerun with warm-up or a new executor. A fresh-process proxy lookup passing is not full corpus acceptance or a test of resource-limit propagation.

The smallest observed workaround is parent-side proxy initialization before the existing fork. It leaves proxy policy and fork-safety checks enabled, and passes this narrow 3.11 probe. It is not a general fix for arbitrary post-fork macOS APIs or imported libraries. Python explicitly warns about mixing macOS `os.fork` with high-level system APIs, including urllib proxy handling. [Python os.fork documentation](https://docs.python.org/3.11/library/os.html#os.fork), [urllib warning](https://docs.python.org/3.11/library/urllib.request.html).

Recommended ownership and sequence:

- **Immediate, small reporting repair in `isolate.py` and `cli.py`.** Track whether the deadline actually expired, keep the original wait status and read/parse failure cause before cleanup, and expose precise child-death information. SIGXCPU remains a CPU-limit outcome; SIGKILL without deadline evidence remains a crash of unknown cause. Keep the current limits and process-group cleanup.
- **Resource repair in `resolve.py` / `discover.py`.** Ensure recognized course files resolve to the validated inputs during candidate calls, including an alias imported before any resource read. This addresses the observed unnecessary fetch. It should not introduce a blanket network block or replace students' learned weights.
- **Process-start decision for the manager.** I recommend a fresh interpreter for macOS CLI student-code execution over treating one API warm-up as a guarantee. The exact owner is the CLI's `_read_repository` / `_run_view` boundary, backed by the isolation utility. The CLI already knows the benchmark ID, repository path and operation, so it can reconstruct its operation after exec and retain the existing result framing. Do not mechanically replace generic `run_isolated(work)` with multiprocessing spawn: existing callers pass closures and loaded state. If this direction is selected, also audit the separate `discover.survey` caller and the scored-run boundary, so a repaired check does not hand off to an unsafe run. The choice between a narrow proxy warm-up mitigation and an exec-based macOS boundary is a product/architecture decision returned to the manager; no new executor or protocol was implemented here.

The safe canonical next comparison is a fresh-process operation using the available Python 3.8.20 interpreter and the same frozen source/data, with the existing limits installed in that worker before student code. The standalone exec mode passed there. Full dependency parity and a complete student check under that design remain untested. No Linux, Windows or hosted environment was tested in this phase.

## Narrow acceptance tests for T3

- The self-SIGKILL child returns a crash with signal 9, no claimed timeout and no inferred OOM when the alarm did not fire.
- A genuine parent deadline records that it fired, reports wall-clock expiry, reaps the child and its descendants, and preserves the existing time/memory/CPU limits. Keep a separate test for an explicit SIGXCPU outcome and its CPU-limit detail.
- EOF or invalid framed output preserves its actual reason instead of becoming a timeout because cleanup used SIGKILL. CLI JSON must retain the child detail/signal.
- The no-network proxy probe passes on macOS 3.11 and 3.8 under the chosen process-start correction, without fork-safety or proxy-policy disable flags. A reader of only `threading.enumerate()` must not be used to declare raw fork safe.
- A tiny fixture imports `get_data_path` into a module-level alias but calls it only later. A mapped, hash-validated course artifact must resolve during the probe without reaching Pooch/Requests. An unmapped file must keep an explicit, honest outcome. Verify this across two sequential repositories to catch leaked mappings.
- After integration, rerun the same failed representatives cold in new evidence directories, then the remaining failed rows only if the correction warrants it. A real scored test is still needed later; binding success is not an algorithm score.

## History and preservation

The exact blobs for `isolate.py`, `cli.py`, `discover.py` and `pipeline.py` are identical between `37b1972` and `c2af396`'s parent, `8e09a07c6e0cce75c70845d4566fd756f390c83b`. These source paths predate the UI-restoration candidate. `preservation-and-history.json` records the blob IDs and confirms all 229 immutable source hashes and the 75 as-found changed-file hashes still match their prior records.

Instrumentation only wrapped calls in the diagnostic process and enabled faulthandler into separate files. `mechanism-summary.json` records signals, alarm events and fork counts. No limit, safety setting, original student file, trained weight or integration file was changed. Pooch created one zero-byte temporary file in its default course cache before the representative Language abort; four other zero-byte files predate this diagnostic phase. Their metadata is retained in `course-cache-side-effects.json`; no existing file was overwritten or cleaned up.

Context7 was attempted and returned its quota error; Python's primary documentation was used for the macOS API warning. Recognition discovery remains a separate known missing capability. The Helium tab was untouched.
