# Make the benchmark actually run on real student repositories

## Context

The portal is a well-built control plane wrapped around an execution path that
has never executed anything. `EXECUTION_PROVIDER` is `"fixture"` in both
environments, so every score students would see today is simulated
(`apps/portal/wrangler.jsonc:75,150`). The Modal runner behind it is written and
tested but switched off: the queue and R2 bindings are commented out
(`wrangler.jsonc:155-172`), so `assertModalConfigured` throws 501 before
anything dispatches (`worker/execution/runner.ts:27-40`).

Underneath that, a harder problem. The runner finds student code by
`pip install -e .` followed by a setuptools entry-point lookup
(`apps/runner-modal/src/cogworks_runner/modal_app.py:183-198`). All seven
repositories from this year's five groups have **no `pyproject.toml`, no
`setup.py`, no `requirements.txt`, and no `benchmark_adapter.py`**. They are
flat scripts (`match.py`, `whispers.py`, `vector_db.py`) or notebooks only. Not
one of them can be built by the current runner, and the fork-of-template check
(`worker/github/template.ts:5-23`) would reject them at connect time anyway,
against a template catalog that is empty (`template-catalog/catalog.json`).

Week 1 (audio) does not exist at all: one inactive catalog row seeded in
`migrations/0002_seed.sql:11`, no plugin, no dataset, no contract.

The goal is a benchmark that runs, on real repositories, for all three weeks,
adapting to whatever architecture a team chose. Ordered by what blocks what:
discovery first (nothing runs without it), then execution, then Week 1.

Two decisions from the owner shape everything below. Fork enforcement and
one-repo-per-team become admin settings rather than invariants. And effort goes
into designing isolation that cannot fail, not into testing isolation that can.

---

## The core idea: a resolution ladder, not a packaging requirement

Everything hangs off one change. `pip install -e .` is replaced by an ordered
ladder that tries the most explicit thing first and reports exactly which rung
it landed on. The rung appears in the run log and in "What the scorer noticed",
so a team always knows how their code was found.

| Rung | Trigger | Mechanism |
| --- | --- | --- |
| 0. Installed entry point | an installed package declares `cogworks.submissions.v2` | loads the package's declared submission |
| 1. Repository declaration | root `cogworks.toml` or `submission.py` | uses the declared root and symbol or imports the root file by path |
| 2. Automatic discovery | neither declaration resolves | selects a root, imports its modules, and binds functions that pass the benchmark probes |

Rung 2 is what makes the seven real repos scoreable, and it is smaller than it
sounds, because it reuses machinery that already exists. `adapt_search` in
`benchmarks/week3/language_search_benchmark/adapters.py:161` resolves protocol
roles against an object by exact documented name, refusing to guess and
producing a mapping report when it cannot. A Python **module object** answers
`getattr` exactly like an instance does. So rung 2 is:

1. pick the root directory (below),
2. `sys.path.insert(0, root)` and `os.chdir(root)`,
3. import every top-level `.py` there, skipping ones that fail,
4. collect them into a namespace and pass it to `adapt_search` / `adapt_recognition`.

No new resolution logic, no new guessing policy, no install. The reason this
matters beyond convenience: installing flat scripts as a package *breaks* them.
`carti4ce/week1_capstone/match.py` does `from database import load`, and
`database.py` writes `DB_PATH = "db.pkl"` relative to the working directory.
Both work under `sys.path` + `chdir`; both break under `pip install -e .`.

Root selection, in order: `cogworks.toml`'s `root`; a directory whose name
matches the benchmark's module (`Week1`, `week2`, `Week 3` — Group 1 keeps all
three weeks in one repository); a single obvious code directory (`code/`,
`src/`); otherwise the repository root. Whichever it picks is logged.

The adapters in `adapters.py` need one extension for this: `_resolve` currently
walks `dir(target)` on one object. It gains the ability to walk a list of
modules in order, reporting mappings module-qualified
(`mapped fingerprint.make_fgp -> fanout_fn`). Same alias tables, same
refuse-to-guess rule.

### What students get in the future

`cogworks init` inspects the repository, proposes a `cogworks.toml`, and prints
what it would resolve. This is a dry run of rung 1 or 2 before any run is spent. A
course template repository carries a working `pyproject.toml`, a
`benchmark_adapter.py` stub, and a `requirements.txt`, so future cohorts start
on rung 0. The ladder is what makes the template a convenience rather than a
prerequisite.

### Dependencies

The image keeps carrying the course stack pre-baked, as it does today for
weeks 2 and 3. A repository's own `requirements.txt`, when present, is installed
at prepare time under a budget, failures downgraded to a warning rather than
aborting the run. `uv` is used inside the image build for speed (the Week 3
image already does, `modal_app.py:108`); students never see it. Nobody is asked
to author packaging metadata to get a score.

**Files:** `python/cogbench/src/cogbench/resolve.py` (new, the ladder — shared
by local and hosted so both resolve identically), `cli.py` (`init`),
`modal_app.py` `PREPARE_SCRIPT`, `benchmarks/week{2,3}/**/adapters.py`.

---

## Phase A — weeks 2 and 3 running on real repositories

### A1. The resolution ladder

`resolve.py` as above, with the two adapter extensions. Verified by scoring the
five real week-2/week-3 repositories locally, on a laptop, before any hosted
infrastructure exists. That is the first honest evidence that any of this works.

### A2. Per-benchmark repository binding

Group 1 keeps three weeks in one repository; Group 5 uses two different owners
across weeks. `teams` carries exactly one repo (`schema.ts:135-140`).

New table `team_benchmark_repositories(team_id, benchmark_id, repo_full_name,
repo_id, subdir, default_branch)`, consulted by `buildRunJob`
(`worker/execution/runner.ts:42-95`) and by `startPracticeRun`, falling back to
`teams.repo*` when no row exists. One repository stays the default and the
recommended shape; a per-week override is available and unremarkable.

**Files:** `apps/portal/migrations/0020_benchmark_repositories.sql`,
`worker/db/schema.ts`, `worker/execution/runner.ts`,
`worker/services/run-actions.ts`, plus a Connections-page surface.

### A3. Settings instead of invariants

`validateTemplateRepository` becomes conditional on a cohort setting, default
off (`worker/github/template.ts`, called from `routes/github.ts:170` and
`routes/team.ts:222`). Same for the public-repository requirement
(`github.ts:151-157`), which blocks a private team repo for no reason that
survives the owner's read.

Quotas, promotion, and refunds stay exactly as they are. They work, they are
already written, and the owner wants them.

### A4. Turn on execution, both paths

**Local.** `cogworks run --benchmark <id>` already executes end to end
(`cogbench/runner.py:execute_installed`); with A1 it works without an install.
`--live`/`sync` report to the portal, labeled self-reported, through the
existing device-token path.

**Hosted.** Flip `EXECUTION_PROVIDER` to `"modal"`, uncomment the queue and R2
bindings (`wrangler.jsonc:155-172`), publish the images with
`apps/runner-modal/tools/deploy.py`, and materialize hidden datasets with the
existing `materialize_week{2,3}_official.py`. The runtime profile table in
`buildRunJob:69-89` needs the per-benchmark memory and Python entries it already
has, plus Week 1 later.

The parts requiring your accounts and credentials — a funded Modal workspace,
`MODAL_RUNNER_URL`, `RUNNER_SIGNING_KEY`, a published image digest — are yours
to provide; everything up to that point is code and is verifiable without them.

### A5. Isolation, by construction

The owner's point applies directly. Gold labels are stripped in
`week3_payload.encode_payload` and re-attached controller-side
(`week3_payload.py:23-51, 111-131`), so hidden answers are absent from the
sandbox by *construction*: there is no code path that could send them. That
design is kept and extended to Week 1. What is not added is a second layer of
runtime assertions checking that the first layer worked.

---

## Phase B — Week 1 audio, built from scratch

Design established; the full rationale and alias provenance live in the design
pass rather than being restated here. The load-bearing decisions:

**Contract.** `add_reference(song_id, samples, sample_rate)` and
`identify(samples, sample_rate) -> str | None`, on float32 mono at 44.1 kHz.
Handing decoded samples rather than file paths keeps codec differences out of
the measurement and keeps `pyaudio`/`microphone` off the required path.
Optional `fingerprint`, `identify_with_confidence`, `finalize_database` feed
secondary metrics only, never the primary — a team must not lose leaderboard
score for naming something differently.

**Composition.** A team with only `find_peaks` + `make_fgp` + `query` and no
`identify` method is scored by composing their own four stages, through *their*
spectrogram (a percentile threshold tuned on `np.log(specgram(...))` is wrong on
`np.log(specgram(..., mode="magnitude"))`; supplying our own would silently
retune their parameters). Every composed step is logged.

Two aliases are deliberately withheld from direct mapping. `carti4ce`'s
`database.add(fanout, song_ID, song_name)` and `match.query(fingerprints)` both
bind cleanly to a samples-taking call and would run on the wrong input,
producing a plausible zero. They are reachable only through composition, where
the benchmark knows what it is passing. Every direct resolution is arity-guarded
with `inspect.signature(...).bind(...)`, the same guard
`benchmarks/week2/facial_recognition_benchmark/adapters.py:49-58` already uses.

**Dataset.** ~60 CC-BY/CC-BY-SA tracks from FMA, 30s each, decoded once
controller-side and shipped as int16 — never mp3, so every team's audio is
bit-identical. Queries at random non-zero offsets with perturbation rungs:
clean, white noise (20/10/5 dB SNR, using the same formula
`carti4ce/tests_manual/test_noisy_queries.py` already uses so local and hosted
numbers compare), room noise, clipping, band-limiting, low-bitrate MP3, partial
overlap. Speed shift is reported and unscored. Plus unknown-song queries for
rejection, including same-artist hard negatives. Synthetic audio is used for the
fast `test` tier only; as a corpus it is degenerate (stationary spectra destroy
the offset histogram the whole voting scheme rests on).

60 songs, not 500, because enrollment cost sets the ceiling: `carti4ce`'s `add`
reloads and rewrites the whole pickle per song, which is O(N²). The number is
provisional until measured against three reference implementations, and the
difficulty curve must be validated to separate untuned from tuned before the
tier is frozen.

**Primary metric.** `identification_score`, open-set F1 over precision and
recall across all scored rungs. Always answering collapses precision; never
answering zeroes recall. One formula, in the scorer, per the rule stated in
`migrations/0018_week3_language.sql`'s header.

**Environment.** These repositories import `librosa`, `numba`, `pyaudio`,
`microphone`, and `matplotlib` at module scope. Installing `libportaudio2` makes
`import pyaudio` succeed — it only fails on device open, which never happens.
`scipy<1.13` is pinned because `g3w1` imports `scipy.ndimage.filters`, removed
in 1.13. `MPLBACKEND=Agg`, `NUMBA_CACHE_DIR`, `PYTHONHASHSEED=0`, and a warm-up
call so numba's first-call JIT is attributed to a named step rather than
appearing as a hang.

**Files:** `benchmarks/week1/audio_identification_benchmark/{contracts,adapters,
checks,datasets,drivers,metrics,faults,plugins}.py` and manifests;
`apps/runner-modal/src/cogworks_runner/week1_payload.py`; `week1_image` and an
`_evaluate_week1` branch in `modal_app.py`;
`apps/portal/migrations/0021_week1_audio.sql`;
`tools/{build_corpus,materialize_week1_official}.py`;
`scripts/validate_week1_submodule.py`.

---

## Verification

Evidence, in the order it becomes available. Each step is real execution, not a
typecheck.

1. **Local, real repositories.** Clone all seven, run
   `cogworks run --benchmark <id>` against each with no packaging added, and
   record for every one: which ladder rung resolved it, the mapping log, the
   metrics, or the specific `AdapterContractError` report. Repositories that
   genuinely cannot be scored (notebooks only) must produce one clear sentence
   naming the fix, not a traceback. This is the acceptance gate for Phase A;
   nothing hosted matters until it passes.
2. **Fault probe.** Extend `apps/runner-modal/tools/probe_student_faults.py` to
   the discovery path: missing root, unimportable module, module-scope hardware
   import, relative pickle path, stale committed database, in-place mutation of
   our arrays, thousands of printed lines. Every variant ends "scored", never
   "RUN RAISED".
3. **Portal, dev.** `pnpm dev`, dev-login, connect a real repository (fork check
   off), bind a per-benchmark repo, start a run, watch the phase rail and log
   through the browser. Confirm the mapping log reaches "What the scorer
   noticed" (`RunDetailPage.tsx:187-202`) and the leaderboard renders signed-out
   with a partial result.
4. **Hosted, once credentials exist.** One practice run through the real Modal
   path per benchmark; verify network is blocked during evaluation, gold is
   absent from the sandbox, a forced timeout leaves no run stuck in
   `evaluating`, and a deliberate student-code failure consumes an attempt while
   an infrastructure failure refunds one.
5. **Week 1 curve.** Score untuned, course-default, and tuned reference
   implementations. If untuned and tuned land within 0.1 of each other on the
   robustness rungs, the rung set is wrong and gets re-weighted before the
   dataset version is frozen.
6. `pnpm check` and `pnpm test:python` at each phase boundary, with
   `validate_week3_submodule.py` added to the root script (it runs in CI but not
   in `pnpm test:python` today).

## Not doing

Rate limiting on join codes and device-start, the dead
`worker/execution/sandbox.ts` and `orchestration/run-workflow.ts` scaffolding,
the unread `outbox_events` consumer, and the design polish listed under CLAUDE.md's
open threads. None of them block a working benchmark; several become easier to
judge once real runs exist.
