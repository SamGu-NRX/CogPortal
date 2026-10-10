# Week 1 Audio Identification — Metadata-Channel Audit

**Instrument under test:** `benchmarks/week1` on branch `obv/products-audio-validity-20261009` (repo `/home/user/work/CogPortal`). The audit began at commit `276da32fc2e6ea3849a06c8c0d5f37417ba31da1` and completed at HEAD `84d5c933190f57787adfa6e45071ed2c9f45fc89`; the only intervening change adds the staff validity kit under `examples/week1-audio-submission/validity/` (4 new files, no benchmark/cogbench/runner edits), so every file:line citation below is exact for both commits.
**Study claim to test:** *absence of plaintext gold in the submission payload is not evidence that the answers are unreachable.*
**Method:** read-only code audit (no files under the repo were modified; no git writes) plus empirical probes run from `/home/user/work/metadata-audit/` against the package via `sys.path`. Probe scripts and their full outputs sit next to this file (`probe_q1..q6*.py`, `probe_q*_output.txt`); the appendix lists every command.

---

## (a) Executive summary — every recoverable channel, ranked by ease

| # | Channel | Where it works | Work required | Expected in-set top-1 |
|---|---|---|---|---|
| 1 | **Import the shipped manifest** — `datasets.load_manifest()` reads `public-evaluation.json` from inside the installed package; it contains plaintext `source_song_id`, `in_set`, offset, seeds for all 252 queries | Local runs; hosted **practice** runs (same package is pip-installed in the student interpreter) | One `import`; answer by call index | **1.0** (measured, full evaluation tier) |
| 2 | **Call-index arithmetic** — enrollments arrive sorted (`song-00..29`), then one warm-up, then queries in manifest order; one query per song per 30-query cell block | Every runner (local, hosted practice *and* official) | Count enroll calls to learn N; answer `sorted_ids[k % N]` on identify #k; skip warm-up | **1.0** in-set (240/240 verified against the shipped manifest) |
| 3 | **gc / sys.modules introspection** — cases (with gold fields and rendered sources) are constructed *before* the student factory is instantiated, in the same interpreter; `gc.get_objects()` walks them from inside `identify` | Local `drivers.run_cases`; hosted `EVALUATE_SCRIPT` (decode precedes `load_student`) | A gc walk, no manifest knowledge needed | **1.0** in-set (measured: 240 objects found locally) |
| 4 | **Payload token inversion** — the hosted payload strips ids but keeps `source_token = sha256(salt:song_id)` *and ships the salt*; the catalog ids are revealed by `enroll()` | Hosted (practice and official) | Read `/tmp/cog-week1-payload.zip`, invert 30 tokens, map back through query order | **1.0** in-set (240/240 measured) |
| 5 | **Corpus re-render + exact hash match** — the manifest (or the payload's `songs` block) carries every per-song seed; `synth.render_from_manifest` + `synth.perturb` reproduce every query clip bit-exactly; `perturb` is importable, so the perturbation pipeline including noise seeds replicates exactly | Anywhere the manifest/payload is present | ~30–60 s of CPU to render 36 songs; build a 252-entry sha256 table or re-derive answers directly | **1.0** (252/252 bit-exact, measured) |
| 6 | **Fingerprint-match (robust variant)** — even with no manifest, `enroll()` hands over the catalog audio; `synth.perturb` replicates the noise model; correlation on hash-based fingerprints recovers gold without exact timing | Anywhere | A working fingerprint pipeline (the staff reference harness is one) | High on clean/noisy/pitch cells; degraded on the 3 s `short` cell; exact number is pipeline-dependent (reasoned from code, not measured) |
| 7 | **Cell/layout metadata** — clip length alone classifies the cell (3 s = `short`, else 10 s); call count reveals layout; per-record `seconds` timing is recorded in outputs | Every runner | Free (side observation) | Auxiliary — sharpens 2/5/6, no standalone score |
| 8 | **Diagnostic-integrity channels** — student-set `PROVENANCE` reaches the run page as "instructor-supplied" text; `mappings` truncated to 12; `KEEP_CANDIDATES=16` truncation; out-of-set query ids (`q0240`–`q0251`) visible in outputs/reports | Every runner | Free | Not score-raising; matters for audit credibility |

Channels 1–5 are each sufficient on their own for a perfect in-set top-1. Channel 2 works even if the manifests were removed from the package entirely; channel 4 works even on official runs whose manifest comes from the hidden volume, because the salt travels with the payload. The study claim is therefore **supported**: the hosted payload does remove *plaintext* gold, and that removal is not evidence of unreachability — the answers remain reachable through at least four independent, low-effort routes.

---

## (b) Evidence per question

All paths are relative to the repo root unless prefixed. Line numbers refer to the pinned commit above.

### Q1 — Execution boundary: same process, same interpreter, plaintext gold importable

**Yes on both counts.**

- The driver runs the submission in-process: `benchmarks/week1/audio_identification_benchmark/drivers.py:177` (`run_cases`) → `:196` (`run_with_adapter`) calls `adapter.identify(...)` at `:273` inside the scorer's interpreter. No subprocess anywhere in the call path.
- The plugin wires `run` straight through: `audio_identification_benchmark/plugins.py:203-206` (`def run` → `drivers.run_cases(...)`), and `score` → `metrics.score_outputs` (`plugins.py:208-210`).
- The same holds for the local `cogbench` path: `python/cogbench/src/cogbench/cli.py:1132-1133` — `_run_view`: *"Resolve and score here; only the serialized report leaves this process."* — and `python/cogbench/src/cogbench/runner.py:196-262` (`_execute_v2`: cases at `:224`, run at `:236`, score at `:251`, all in-process). Only *discovery* runs in a killable child (`python/cogbench/src/cogbench/isolate.py:1-16`, `run_isolated` at `:599`).
- The hosted path is also one interpreter: `apps/runner-modal/src/cogworks_runner/modal_app.py:920-955` — the evaluate script decodes the payload (`:920-926`), loads the benchmark (`:935`), creates the scratch `model_factory()` (`:940`), imports the student submission (`:944-946`, `load_student` at `:835-842`), and calls `benchmark.run(factory, resources, cases)` under a stdout/stderr redirect (`:947-953`).
- The package — including the manifests directory — is installed into the student's interpreter. Locally by `pip install -e benchmarks/week1`; on hosted by the image build, `modal_app.py:411-413` (source copied to `/opt/week1`, `pip install --no-deps /opt/week1`) and `:436` (same install into the `/opt/cogworks-py38` venv that actually executes student code, `WEEK1_STUDENT_PYTHON = ENVIRONMENT.PY38_VENV` at `modal_app.py:349`).
- `datasets.load_manifest` reads the shipped JSON from package data, no network, no cache: `benchmarks/week1/audio_identification_benchmark/datasets.py:107-130` (docstring at `:108`; package-resource read of `public-{tier}.json` at `:112-120`). The manifest rows carry plaintext gold: measured `q0000 → song-00, in_set=true, cell=clean, offset 8.3075, noise_seed 1607937033` (probe Q1, section A).
- `materialize_cases` builds the case objects the scorer uses, with gold on them: `datasets.py:134-186` (enrollments `sorted(catalog)` at `:144-146`; per-row `QueryCase(... gold_song_id=..., offset_seconds=..., noise_seed=..., source_song_id=...)` at `:150-170`). Because the factory is instantiated *after* these objects exist (`drivers.py:177-194`), student code can find them via `gc` — measured: a gc walk from module scope found all 240 in-set `QueryCase` objects with their `gold_song_id` (probe Q1, section C).
- **Empirical:** a submission that never reads audio — it imports the manifest and answers by call index — scored through the real driver and scorer: `identification_score = 1.0` (`clean/noisy/short/pitch` cells all 1.0; chance 0.0333) on the full 30-song evaluation tier (probe Q1, section D; `probe_q1_output.txt`).

### Q2 — Call-order leakage: the exact presentation order

The deterministic sequence the driver presents (`drivers.py:196-331`):

1. **Enrollment** — every catalog song, `sorted(catalog)` order (`datasets.py:144-146`), one `enroll(song_id, samples, sr)` per song (`drivers.py:213-232`; the song id is passed in the clear at `:227`). Measured on the test tier: `('enroll', 'song-00', 529200)`, `song-01`, `song-02`, …
2. **Warm-up** — exactly one throwaway `identify` on 1 second of zeros, before the first query: `drivers.py:156-174` (`_warm_up`, docstring: *"One throwaway identify, so JIT and lazy imports are not query 1's cost"*; the zeros clip at `:169`). Measured: `('identify', 44100, zeros=True)`.
3. **Queries** — every `QueryCase` in manifest row order (`datasets.py:148-170` iterates `manifest["queries"]` and appends; the driver iterates cases in list order, `drivers.py:257-293`). The shipped evaluation manifest is built as eight contiguous in-set blocks of 30 (one query per song per block, songs in sorted order), then 12 out-of-set rows: blocks at in-set indices `[0,30,60,90,120,150,180,210]` for cells `clean, short, noisy, noisy_mid, pitch_down_2, pitch_down_1, pitch_up_1, pitch_up_2`; out-of-set at indices 240–251 (verified from the manifest; block starts also follow from `_cells`/row construction in `datasets.py`).

**Gold from the index alone:** within each block, position maps to the sorted song id, so query k → `song-{k % N:02d}`. Measured against the shipped evaluation manifest: **240/240 in-set queries correct** from the identify call index alone, with no audio inspection (probe Q2, section B; `probe_q2_output.txt`). The submission learns N from its own enroll calls (`len([enroll])`), so this channel survives even if the manifest were removed from the package.

**How a metadata-only submission skips the warm-up:** either
- *content rule*: the warm-up is the only identify whose samples are `sample_rate` long and all zeros — `if len(samples) == sample_rate and not samples.any(): return []` (used in the Q1 attack; measured: warm-up detected and skipped, 240/240 query calls consumed, counter aligned), or
- *positional rule*: the warm-up is deterministically the **first** identify call after enrollment (`drivers.py:252-254` runs it unconditionally before the query loop), so a counter that ignores call #0 achieves the same alignment without inspecting audio.

A submission that fails to skip the warm-up is only off by one — it can re-sync from the clip-length histogram (the warm-up is 1 s; the `short` cell is 3 s; nothing else is 1 s).

### Q3 — Hosted sandbox: what student code can see

From `apps/runner-modal/`:

- **Sandbox and network.** The week1 evaluation sandbox is created with `block_network=True` (`modal_app.py:1900-1905`); the same is true of the other run paths (`:1718-1719`, `:1777-1778`, `:1839-1840`). The runbook states it as policy: *"runs network-blocked, so anything a submission needs has to be in the image"* (`docs/runbooks/hosted-benchmarks.md:188`, also `:115`, `:130`). So student code cannot fetch anything — but also does not need to.
- **Filesystem.** The controller writes the payload to `/tmp/cog-week1-payload.zip` (`modal_app.py:1907-1912`) and the evaluate script to `/tmp/cog-evaluate.py`; the student repo is unpacked from a tarball (≤100 MiB, path-sanitized, `:513-546`) and recorded in `/tmp/project-root.txt`. The evaluate script chdirs to the repo root and puts it on `sys.path` before importing the submission (`modal_app.py:821-825`), so student code can read its own repository **and** the payload zip on the same filesystem — there is no per-case chroot between them.
- **Environment variables.** The evaluate script sets `COGWORKS_SHOWCASE` in the shared interpreter (`modal_app.py:929-930`) — student-readable, and it tells the submission which mode it is in. Nothing else benchmark-specific is set for week1 (the `PYTHONHASHSEED=0` block at `:385-389` belongs to the week3/benchmark image, not `week1_image`).
- **Is the benchmark package importable? Yes.** `week1_image` copies `benchmarks/week1` to `/opt/week1` and pip-installs it — no-deps — into both the image interpreter (`modal_app.py:411-413`) and the py38 venv that runs student code (`:435-436`). `import audio_identification_benchmark.datasets` inside student code therefore resolves to the same installed package (same `sys.modules` entry) the scorer uses, and `load_manifest` reads the manifests packaged under it.
- **Is the manifest present?** Two cases, decided by `_week1_manifest` (`modal_app.py:1442-1473`): **practice** runs use the manifest shipped inside the plugin (`load_manifest("evaluation")`, `:1451-1457`) — the docstring states the design concern plainly: *"a manifest that ships with the package is one a student can read."* **Official** runs read `/hidden/audio-identification/{datasetVersion}/manifest.json` from the hidden volume (`:1458-1466`); that manifest never enters the sandbox as a file.
- **But the payload re-opens the door.** `encode_payload` (`apps/runner-modal/src/cogworks_runner/week1_payload.py:59-110`) strips `source_song_id` and `in_set` and emits `source_token = sha256("{salt}:{song_id}")` (`_token` at `:42-44`; per-row token at `:95`) — **and ships the salt** (`"salt": salt` at `:109`, salt derived from `manifest_id:master_seed` at `:72`). The payload also carries every render seed and every query perturbation parameter (offset, pitch, snr, `noise_seed`) plus the full out-of-set catalog (`out_of_set_songs`). Measured: the evaluation payload is 7,360 bytes; `metadata.json` keys are `benchmark_id, corpus_version, out_of_set_songs, queries, salt, sample_rate, showcase, songs`; token inversion against the 30 ids a submission learns from `enroll()` resolved **240/240** in-set queries to their true gold ids, and a clip re-rendered from payload metadata alone was bit-identical (same sha256) to the corpus clip (probe Q3; `probe_q3_output.txt`).
- Decode-side case construction also precedes the student import in the same process (`modal_app.py:920-926` before `:944-946`), so the gc channel of Q1 applies on hosted runs as well (reasoned from code; the mechanism itself is measured locally in Q1 section C).

### Q4 — Local `cogbench` path

- **Plugin discovery:** the benchmark registers the entry point `cogworks.benchmarks.v2 → audio-identification = audio_identification_benchmark.plugins:AudioIdentificationBenchmark` (`benchmarks/week1/pyproject.toml:20-21`); `cogbench.plugins.load_benchmark` resolves it (`python/cogbench/src/cogbench/plugins.py:137-139`, `load_plugin` at `:93`). (The brief's guessed `roles.py` does not exist in `python/cogbench/src/cogbench/`; the comparable modules are `discover.py` + `isolate.py`.)
- **Submission resolution:** `resolve_submission` (`plugins.py:159+`) tries a **file first** — `submission.py` or `benchmark_adapter.py` at the repo root (`python/cogbench/src/cogbench/apploader.py:41` `CANDIDATE_FILENAMES`, `:201` `resolve_submission_file`) — with `repo_root` defaulting to `Path.cwd()` (`plugins.py:170`), then falls back to the `cogworks.submissions.v2` entry-point group (`load_submission`, `plugins.py:143+`; docstring: *"The file fallback is what actually serves student repositories"*). A file that exists but is broken is final (`plugins.py:181-186`) — its error is the student's answer, not a fallback trigger.
- **Discovery mode:** when nothing declares a submission, `cogbench.discover` probes for enroll/query-shaped functions; because that runs unvetted code, discovery executes in a resource-limited child process (`isolate.py:1-16`, `run_isolated` `:599+`) and only names — never live objects — cross the boundary. The scored run itself is back in-process.
- **Run path:** `cli.py:1132` `_run_view` ("Resolve and score here") → `runner.execute` (`runner.py:65`) → `_execute_v2` (`runner.py:196`): tier is `"test"` if smoke else `"evaluation"` (`:206`); `cases = list(benchmark.load_cases(tier))` (`:224`) — **the same plaintext-gold-bearing cases as Q1** (measured: on the test tier, 64/68 query cases carry `gold_song_id`; the 4 `None`s are out-of-set) — then `outputs = list(benchmark.run(factory, model_factory(), cases))` (`:236`) and `scores = benchmark.score(outputs, cases)` (`:251`), all in one process.
- **Empirical:** with `cwd` set to the staff example repository, `resolve_submission` resolved by file (`source='file', detail='submission.py:create_submission'`), and `execute(benchmark, OrderAttack, cwd, smoke=False)` — the real v2 local path, evaluation tier — scored the same metadata-only attack at **`identification_score = 1.0`** in 38.8 s (probe Q4; `probe_q4_output.txt`).

### Q5 — Corpus reconstruction

- The manifest pins per-song construction seeds (`datasets.py:360` writes the `songs` rows with `seed` and `sha256`; synth renders deterministically from `SongSpec`), and `synth.render_from_manifest(manifest, verify=True)` renders the catalog **and** the out-of-set half with per-song sha256 verification (`benchmarks/week1/audio_identification_benchmark/synth.py:619-630`, `render_corpus` at `:310`, `sha256_signal` at `:303`).
- The perturbation pipeline is importable by the same route: `synth.perturb(source, sr, clip_seconds, offset, pitch, snr, noise_seed)` (`synth.py:413`) takes exactly the fields every manifest/payload query row carries — so a submission can replicate not just the audio but the exact noise instance of each query.
- **Empirical, full evaluation tier:** `render_from_manifest(verify=True)` rendered all 36 songs (30 catalog + 6 `unseen-*`) in 29.2 s with every render matching its manifest sha256; rebuilding all 252 query clips and comparing sha256 against the scorer's own `materialize_cases` output gave **252/252 bit-exact**, including 12/12 out-of-set rows; a clean 10 s clip from an out-of-set song reproduces bit-exactly as well (probe Q5; `probe_q5_output.txt`).
- Consequence: a submission can build a 252-entry `sha256 → gold` table (~30–60 s of one-time compute) and answer every query by hash lookup of the incoming clip — an **exact membership oracle** that also flags out-of-set clips (no hash hit) for safe abstention. The robust variant (fingerprint matching against the enrolled catalog audio, using `synth.perturb` to replicate the noise model, as the staff reference pipeline does — `examples/week1-audio-submission/README.md:55` `reference_shazam/pipeline.py`) does not even need the manifest: `enroll()` hands over the catalog audio itself.

### Q6 — Other channels found

- **`KEEP_CANDIDATES` truncation (drivers.py:46, `:285`, `:287-290`).** The driver stores at most 16 candidates per query regardless of what the submission returned — measured: a submission returning 20 candidates has every output record truncated to exactly 16. The stored list length is a driver artifact, not a leak of the submission's depth; its audit value is that per-record shape is platform-controlled and should not be read as submission behavior.
- **Output-record fields and out-of-set disclosure.** Query records are `{ok, kind, query_id, candidates, scores, shape, seconds}` (`drivers.py:276-293`). All 252 outputs — including the 12 out-of-set ones — are kept and keyed by `query_id` (`q0240`–`q0251`, measured), and `metrics.score_outputs` reads the mapping log from the outputs (`metrics.py:208-213`). Any report, JSON dump, or run page derived from outputs therefore discloses exactly which queries were never scored — the out-of-set boundary is public after a run.
- **Per-record timing.** `seconds` is wall-clock around each `identify` (`drivers.py:271-272`, stored at `:292`) and feeds run diagnostics (`metrics.py:216-219`). It is an information channel about the run environment (and, in principle, a side channel for correlating calls), though the no-op attack's measured 0.0 s values show it is coarse.
- **`PROVENANCE` spoofing (adapters.py:90-93, drivers.py:317-330).** The adapter reads `PROVENANCE` from the student object or its module (`adapters.py:90-93`); the driver prepends a run-page note for any provenance whose `source != "student"` (`drivers.py:317-328`), attaching `mappings` to `outputs[0]` (`:330`, truncated to 12 entries). A submission can therefore put arbitrary text on the run page disguised as instructor-supplied context — measured: `PROVENANCE = {"source": "instructor", "we_supplied": ["<arbitrary student text>"]}` produced `['scored through an instructor-supplied adapter; we supplied: <arbitrary student text>']` on the output record (probe Q6, section B2).
- **Cell geometry is fully enumerable.** One 3 s cell (`short`, 30 queries), seven 10 s in-set cells, 12 out-of-set 10 s queries (verified from the manifest); identify-clip length alone classifies the cell (`probe_q6_output.txt`, section C: 254 calls = 2 warm-ups of 44,100 + 222 × 441,000 + 30 × 132,300; the second 44,100 is the warm-up of the probe's second `run_cases` invocation — one warm-up per run, `drivers.py:252-254`).
- **Anti-channels (deliberate, working as intended).** `prepare_process` forces matplotlib onto Agg and closes/replaces stdin before student code runs (`drivers.py:49-59`); the working directory during queries is the private per-run scratch dir (`drivers.py:49-70`, `contracts.py:60-64`, `plugins.py:246-256`); hosted student stdout/stderr is captured to a head+tail bounded buffer (`modal_app.py:759-800`) rather than returned in full. None of these leak gold; they bound what a stuck submission can do to the run.

---

## (c) Recovery recipes

Each recipe lists: metadata used, work required, expected in-set top-1.

**R1 — Manifest import (local & hosted practice).**
Metadata: `public-evaluation.json` inside the installed package (all gold fields).
Work: `from audio_identification_benchmark import datasets; rows = datasets.load_manifest("evaluation")["queries"]`; keep the in-set rows in order; answer `rows[i].source_song_id` on identify #i; skip the 1 s zeros call.
Top-1: **1.0** (measured end-to-end through `drivers.run_cases` + `score_outputs` and through `cogbench.runner.execute`).

**R2 — Call-index arithmetic (works everywhere, even manifest-less).**
Metadata: the presentation order itself — N from enroll-call count; sorted-song, one-per-song cell blocks; warm-up at a fixed position.
Work: `ids = [f"song-{i:02d}" for i in range(N)]` (or sorted ids as enrolled); on the k-th non-warm-up identify return `ids[k % N]`.
Top-1: **1.0** in-set on the shipped grid (240/240 measured against the manifest); holds on any manifest built by the same one-per-song-per-block construction.

**R3 — Payload token inversion (hosted, practice and official).**
Metadata: `metadata.json` inside `/tmp/cog-week1-payload.zip` — `salt`, `songs[].song_id` (also obtainable from enroll), per-query `source_token`, full perturbation parameters, `out_of_set_songs`.
Work: `{sha256(f"{salt}:{sid}"): sid}` for the 30 known ids; map each query's token back to an id; unmatched tokens are out-of-set (free abstention).
Top-1: **1.0** in-set (240/240 measured against the true manifest gold).

**R4 — Corpus re-render + exact hash oracle.**
Metadata: per-song seeds and per-query perturbation parameters (manifest, or payload metadata on hosted runs).
Work: `synth.render_from_manifest(manifest, verify=True)` (~30–60 s), `synth.perturb` per row, `sha256_signal` per clip → 252-entry table; answer by hashing the incoming clip (or skip the table and answer by index as in R1).
Top-1: **1.0** (252/252 bit-exact, measured); perfect out-of-set abstention as a side effect.

**R5 — Fingerprint-match (robust, manifest-optional).**
Metadata: none beyond the catalog audio delivered by `enroll()` (plus `synth.perturb` if the manifest is available and noise replication is wanted).
Work: any hash-based fingerprint pipeline over the enrolled catalog; match incoming clips (the staff reference `reference_shazam/pipeline.py` is exactly this).
Top-1: high on `clean`/`noisy`/`noisy_mid`/pitch cells; materially lower on the 3 s `short` cell; pipeline-dependent (reasoned from code and the calibration docs — not measured here).

**R6 — gc introspection (works wherever cases precede student code).**
Metadata: the scorer's own in-memory `QueryCase` objects (`gold_song_id`, `source_song_id`, offsets, seeds) — no manifest or payload needed.
Work: `[o for o in gc.get_objects() if isinstance(o, QueryCase) and o.kind == "in_set"]` at factory time; map `query_id → gold_song_id`; the driver passes `query_id`-shaped context only through order, so align by call index (or by clip length/position).
Top-1: **1.0** in-set (measured locally: 240 objects recovered; hosted order — decode before `load_student` — makes it available there too).

**R7 — Layout/timing metadata (auxiliary).**
Metadata: clip lengths (cell classification), total call count, per-record `seconds`.
Work: passive observation. Top-1: none alone; it hardens R1–R6 against counter drift and enables per-cell strategy.

**R8 — Diagnostic-integrity channels (not score-raising).**
Metadata: student-set `PROVENANCE` (`adapters.py:90-93` → run page via `drivers.py:317-330`); `mappings` cap of 12 (`drivers.py:330`); `KEEP_CANDIDATES=16` (`drivers.py:46`); out-of-set ids visible in outputs.
Work: trivial. Effect: arbitrary student-authored text can appear on the run page attributed to instructors; a run's report discloses the scored/unscored split. Audit-relevant, not score-raising.

---

## (d) What would close each channel

| Channel | Mitigation that actually closes it | Residual risk |
|---|---|---|
| R1 manifest import | Stop shipping gold-bearing manifests in the installable package: split public parameters (cell grid, clip lengths) from gold (`source_song_id`, `in_set`) and serve gold from a store the student interpreter never receives. Pair with R2/R3/R6 rows below — removing the manifest alone closes only R1. | R2 (structure), R3 (payload), R6 (gc) remain open |
| R2 call-index arithmetic | Per-submission randomized presentation: shuffle query order and enrollment order per run, keep the mapping controller-side, and randomize (or drop) the fixed warm-up. Vary clip lengths within cells. | A determined submission can still fingerprint cells by content; shuffle removes the deterministic k→gold map, reducing it to chance (0.033) |
| R3 payload token inversion | Never send the salt: HMAC tokens with a key kept controller-side, or drop tokens and ship per-query rendered clips from the controller (rendering happens outside the sandbox). If payloads must stay manifest-shaped, at minimum make tokens random per query with the mapping held by the controller. | Payload still carries seeds; pair with the R4 row |
| R4 re-render/hash match | Run-unique seeds: derive per-song seeds per submission run (cryptographically random, generated controller-side) so no precomputed table from a shipped manifest matches. For full closure, render clips controller-side and stream audio only — the payload currently carries all seeds by design (`week1_payload.py:59-110`). | Seeds in the payload keep replication possible; only controller-side rendering closes it |
| R5 fingerprint match | Nothing cheap — the catalog audio is inherently handed to the submission by the `enroll()` contract. Accept it (fingerprinting is the skill being taught); the mitigation is interpreting scores, not blocking. | Inherent to the task |
| R6 gc introspection | Run student code in a child process — `cogbench.isolate.run_isolated` (`isolate.py:599+`) already does exactly this for discovery; extend it to the scored run (pipe clips in, candidates out). Construct cases only after the student factory exists, or strip gold before the student process starts. | Subprocess adds IPC complexity; clip streaming cost |
| R7 layout/timing | Aggregate or drop per-record `seconds`; equalize clip lengths across cells or randomize lengths within cells. | Cosmetic; not score-relevant |
| R8 provenance/diagnostics | Require provenance to be asserted by the controller or instructor tooling, never read from the student object (`drivers.py:317-328` should ignore student-supplied `PROVENANCE`, or verify it against a controller-signed token). Filter out-of-set records (or their ids) from student-visible reports when OOS status is meant to be blind. | None; both are small driver changes |

Two structural notes for the study:

1. **Official-run confidentiality currently rests on the hidden volume, not on the payload.** `_week1_manifest` keeps the official manifest off the sandbox filesystem (`modal_app.py:1458-1466`), but `encode_payload` then rebuilds an equivalent oracle (salted tokens + seeds) and ships it to the same sandbox (`modal_app.py:1907-1912`). The confidentiality boundary and the compute boundary are the same process; R3 shows the boundary does not hold.
2. **The warm-up and block geometry are load-bearing determinism.** Every deterministic choice that makes the run reproducible and debuggable (sorted enrollment, fixed warm-up, manifest-order queries, one-per-song blocks) is also what makes R2 possible. Closing R2 means giving up presentation determinism, which costs debuggability — that trade should be made explicitly, not by accident.

---

## (e) Appendix — probe commands and outputs

All probes ran with `python3` 3.13.14 / numpy 2.3.5 on the repo sandbox, importing the pinned package via `sys.path.insert(0, /home/user/work/CogPortal/benchmarks/week1)`. Full outputs are in `probe_q*_output.txt` next to this file; the decisive lines are quoted below.

```
$ python3 /home/user/work/metadata-audit/probe_q1_same_process.py
=== A. plaintext gold reachable from inside a submission process ===
load_manifest('evaluation') -> 252 query rows, 30 songs, manifest_id=week1-evaluation-v1
first 3 rows as a submission sees them (plaintext gold):
   {"query_id": "q0000", "source_song_id": "song-00", "in_set": true, "cell": "clean",
    "clip_seconds": 10.0, "offset_seconds": 8.3075, "pitch_semitones": 0.0,
    "snr_db": null, "noise_seed": 1607937033}
   {"query_id": "q0001", "source_song_id": "song-01", ...}
   {"query_id": "q0002", "source_song_id": "song-02", ...}
=== B. materialize the corpus (what the scorer hands the driver) ===
materialize_cases -> 30 enroll cases + 252 query cases (28.9s)
=== C. gc channel ===
gc walk from 'student-side' module scope found 240 in-set QueryCase objects
=== D. attack run through drivers.run_cases + score_outputs ===
warm-up detected and skipped by zeros rule: True; query calls consumed: 240 of 240 in-set queries
identification_score = 1.0
clean_top1=1.0 noisy_top1=1.0 short_clip_top1=1.0 pitch_top1=1.0 chance_top1=0.0333
```
(First run returned 0.0 because the probe returned a bare `[id, score]` list, which `coerce_candidates` rejects — the platform correctly scored the malformed shape at zero; fixed to `[(id, score)]`.)

```
$ python3 /home/user/work/metadata-audit/probe_q2_call_order.py
=== A. observed call order on the test tier (spy adapter) ===
first 3 calls: [('enroll', 'song-00', 529200), ('enroll', 'song-01', 529200), ('enroll', 'song-02', 529200)]
warm-up call (first identify): ('identify', 44100, True)
total calls: 77 = 8 enroll + 1 warm-up + 68 identify
=== B. gold from identify index alone, evaluation tier (no audio used) ===
evaluation tier: 252 queries, 240 in-set, 30 enrolled songs
index->gold rule 'song-{k % 30:02d}': 240/240 in-set queries correct
cell blocks (in-set index ranges): [(0, 'clean'), (30, 'short'), (60, 'noisy'), (90, 'noisy_mid'),
 (120, 'pitch_down_2'), (150, 'pitch_down_1'), (180, 'pitch_up_1'), (210, 'pitch_up_2')]
out-of-set indices (never scored): [(240, 'q0240'), ..., (251, 'q0251')]
```

```
$ python3 /home/user/work/metadata-audit/probe_q3_hosted_payload.py
=== A. controller side ===
encode_payload -> 7360 bytes
=== B. student side ===
metadata.json keys: ['benchmark_id', 'corpus_version', 'out_of_set_songs', 'queries', 'salt', 'sample_rate', 'showcase', 'songs']
salt in payload: week1-evaluation-v1:719241703
token table built from salt + 30 known song ids
token inversion: 240/252 queries resolved to an enrolled song id
=== C. check against true gold ===
recovered gold matches the true manifest gold for 240/240 in-set queries
=== D. clip re-render from payload metadata alone is bit-exact ===
payload-rendered clip == manifest-rendered clip: True
sha256: 6ec1d8298e545de4d02835306681aa5c54086ca6b4ad21e131e525ac6ae66dff
```

```
$ python3 /home/user/work/metadata-audit/probe_q4_local_cogbench.py
=== A. cogbench resolves a submission by file, in this process ===
resolve_submission -> source='file' detail='submission.py:create_submission'
=== B. the v2 execute path ===
benchmark.load_cases -> cases carry gold: 64/68 query cases have gold_song_id
=== C. metadata-attack submission scored through the real local runner ===
execute() -> LocalReport in 38.8s
identification_score = 1.0
clean_top1=1.0 pitch_top1=1.0 chance_top1=0.0333
```

```
$ python3 /home/user/work/metadata-audit/probe_q5_corpus_reconstruction.py
=== A. render the full catalog from manifest seeds (hash-verified) ===
render_from_manifest(verify=True) -> 36 songs in 29.2s; every render matched its manifest sha256
=== B. bit-exact clip replication for all 252 queries ===
sha256(rebuilt clip) == sha256(scorer's clip): 252/252
=== C. out-of-set songs are in the same renderable hash space ===
out-of-set query clips rebuilt bit-exactly: 12/12
clean 10 s clip from out-of-set unseen-00 (offset 5.0) hash: bfc0b592d086697f...
```

```
$ python3 /home/user/work/metadata-audit/probe_q6_channels.py
driver.KEEP_CANDIDATES = 16
=== A. ===
submission returned 20 candidates; driver stored {16}
=== B. ===
keys of a query output record: ['candidates', 'kind', 'ok', 'query_id', 'scores', 'seconds', 'shape']
out-of-set records kept in outputs: 12; ids: ['q0240', ..., 'q0251']
per-record 'seconds' timing field, first 3 queries: [('q0000', 0.0), ('q0001', 0.0), ('q0002', 0.0)]
=== B2. provenance channel ===
last output's 'mappings' after PROVENANCE spoof:
 ['scored through an instructor-supplied adapter; we supplied: <arbitrary student text>']
=== C. ===
identify clip-length histogram over 254 calls: {44100: 2, 441000: 222, 132300: 30}
manifest clip_seconds histogram: {'10.0': 222, '3.0': 30}
warm-up call was first and had length 44100
```

Cell geometry verification (read-only one-liner):
```
$ python3 -c "...Counter((cell, clip_seconds) for in_set rows)..."
('clean','10.0') 30  ('noisy','10.0') 30  ('noisy_mid','10.0') 30
('pitch_down_1','10.0') 30  ('pitch_down_2','10.0') 30
('pitch_up_1','10.0') 30  ('pitch_up_2','10.0') 30  ('short','3.0') 30
oos clip_seconds: {'10.0': 12}   oos cells: {'out_of_set': 12}
songs: 30  out_of_set_songs: 6
```

Timing pre-check (sized the probes):
```
render 45s song: 1.60s, shape (1984500,)
perturb 10s pitch -2: 0.016s
```

**Probe-side corrections made along the way (recorded for honesty):** the Q1 attack's first run returned a malformed candidate shape (scored 0.0 — the platform's error handling working as designed); `render_from_manifest` was first called with the wrong signature; the Q6 out-of-set filter initially matched `q0200` (in-set) before being corrected to `q0240+`; the first Q6 mappings demo assumed adapter attribute forwarding that does not exist and was replaced with the PROVENANCE channel, which does.

---

## Provenance note (added at recovery)

This audit ran against the study tree at commit `84d5c93` on a local-only
branch that never reached the remote. The study was recovered onto
`obv/products-audio-validity-20261009-r1` (base `276da32`, off
`fix/device-link-recovery-20261004`) as cherry-pick `ebdb309` with identical
content; every `file:line` citation above is exact for `ebdb309` as well.
Post-audit study changes are limited to `validity/` files this audit does not
cite: `StudyQueryCase` now subclasses the benchmark's `QueryCase` so the
driver's single execution path runs study rows, and a `call_order` variant
(channel 2 of the executive summary) was registered as a measured control.
