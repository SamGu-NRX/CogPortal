# Discovery v2: make the search exhaust every honest way of calling their code

## Why
Ground truth (10 hand-wired repos, each independently re-verified): 8 of 10 refused repos are
wirable with THEIR functions and no algorithm substitution. Two are not (Asterisk W1 has no store
function at all; rutvim W2's only graph builder has three source-level bugs). The resolver refuses
the eight because it lacks a small number of GENERIC primitives, each named below with the repo
that needs it. Nothing here is a per-repo alias.

## Invariants (unchanged)
- Lexical evidence (names) never decides; only running their code and the week's accepts() does.
- Never substitute our algorithm. Supplying INPUT is allowed: data, a seed, a required cutoff, a
  file path, a resource the benchmark owns (glove/model), a required "name" arg that is photo identity.
- Everything supplied is recorded on the binding and disclosed on the run page as supplied.
- Deterministic: same repo bytes -> same binding -> same score (seed random+numpy, PYTHONHASHSEED).
- A refusal names the furthest point reached and one next step; a repo with no honest chain is refused.

## New generic primitives (cogbench), each with the corpus case that requires it

P1. `Stage.extra` : side inputs handed to every call of that stage after the positional value.
    Tried as trailing args (like tunings) AND by keyword where the signature names them.
    - W3 Lashika/Bagel/CogFinder/rutvim: embed(text, glove, idfs) needs benchmark glove + THEIR idf table.
    - W2 CoggurtFilter: detect_and_describe(model, image) needs the benchmark FaceNet as FIRST arg
      -> so extras must also be tried LEADING. Rule: try (value, *extras), then (*extras, value).

P2. Side-input (fit) stages: a stage whose output is not a chain value but an argument to a later
    stage, computed once from a benchmark corpus. Declared as `Stage(kind="fit", fixture=corpus,
    produces=dict_like)`; its result is added to the extras pool for downstream stages.
    - W3 all four: compute_idfs(corpus) -> dict; find_idfs; compute_idf.

P3. Constructor-as-stage: a class whose __init__ takes the stage's inputs IS the stage; the instance
    is the value; its methods are the next stages' candidates (bound methods, instance carried).
    - W3 Lashika ImageDatabase(image_ids, descriptors, W); Bagel CaptionImageQuery(embeddings, ids);
    - W2 Bagel Whispers(vectors, names, threshold) then .create_matrix() .create_nodes() .train_sweeps().
    Requires: instances_in must also enumerate classes with required args, constructing them AT the
    stage with the stage's inputs (+ extras + tunings), never up front.

P4. Multi-branch roles: W3 is four surfaces sharing state, not one linear chain. Role gains
    `branches`: ordered sub-chains with a shared extras pool and a shared instance pool.
    text: captions -> (N,D). image: descriptors -> (M,D). prepare: (ids, descriptors) -> store.
    search: (query, k) -> ids. accepts() runs the benchmark's own 9-case driver on the composed object.

P5. Element hand-off for per_item: when a per-item call returns a tuple, offer each element of EACH
    item (gather element k across items). - W2 Bagel file_descriptors(p) -> (boxes, probs, desc); desc
    is element [2]. Currently _mapped gathers whole tuples and looks_like_descriptors fails.

P6. Required non-tuning args of INPUT kind: `Stage.identity` = the benchmark can pass the item's
    identity (path/index) to any string/name-typed required arg. - W2 Bagel Whispers(vectors, names, thr).

P7. Import ladder, three additions, all disclosed in the survey:
    a. Notebook lift joins cells with "\n" (Cog-gurts W1: 24 boundaries lack a newline; rutvim W1
       metadata.ipynb "import uuidclass"). Bug, not feature.
    b. Module-scope file reads: when import raises FileNotFoundError/IsADirectoryError on a RELATIVE
       path, retry once with cwd = the module's own directory (Cog-gurts W1 Day 4/ reads data/trumpet.wav;
       Bagel W2 cluster.py reads tests_manual/db.pkl). Disclosed as "imported from its own folder".
       Never retry a read of an ABSOLUTE path outside the repo.
    c. `from __future__ import annotations` compile flag when a module fails with NameError inside an
       annotation only (Cog-gurts W1: `-> Tuple[Dict[DatabaseKey,...]]` with DatabaseKey undefined).
       Detect: NameError whose traceback frame is the def line. Disclosed.
    d. Stub list += networkx? NO: sandbox has networkx (modal_app.py:126). Stub list += camera, ipynb?
       ipynb: NO, implement `ipynb.fs.full.<stem>` resolution natively: it means "the defs of
       <stem>.ipynb", which the lifter already produces (rutvim W1). camera: yes, returns None.
    e. Absolute foreign path in a resource load (rutvim W3 KeyedVectors.load(r'C:\...\glove.6B.200d.kv')):
       when a module fails at import with a path whose BASENAME matches a benchmark-owned resource
       (glove*.kv / glove*.w2v / captions_train2014.json / resnet18_features.pkl), redirect that ONE
       basename to the benchmark's copy via a tiny finder hook, disclosed as "their path to glove
       redirected to the benchmark's copy". Input substitution; the file is the same course artifact.
       cogworks_data.get_data_path(name) likewise resolves to COGWORKS_LANGUAGE_DATA in the sandbox.

P8. Instance state via __new__ when __init__ is welded to their folder: NO. That is our decision
    about their constructor. Instead: P7b (cwd retry) + P3 handle CoggurtFilter? No: clusterCreator
    __init__ reads baseImages/ unconditionally. Resolution: P3 constructs with the stage inputs; if
    __init__ takes zero args and reads a folder, offer the benchmark's photos AS that folder by running
    the ctor with cwd=scratch containing the photos under the same relative folder name their code
    reads (detected via audit hook on os.listdir/scandir/glob during a dry ctor call). Disclosed as
    "their baseImages/ folder was pointed at the benchmark's photos". This is input, not algorithm:
    they wrote a pipeline over a folder; we hand them a folder.

P9. W1: query tuple/dict shapes. Their match_fingerprint(fp, hash_map, song_index) needs an id->name
    table (identity) and the db's hash_map attribute: P6 covers the identity table; P3 covers the
    instance; the arrangements gain "instance attribute as store arg" (store=db.add_hash per item,
    query reads db.hash_map). The generator escape in roles._attempt (fanout_pairs as query) is a bug:
    _winner must be inside the try.
    W1 rutvim: dict-first-arg store (add_fingerprints(db, id, fps)); arrangements gain a
    "database object as leading arg" form where db = create_database() found as a zero-arg factory
    whose return the store/query both take first. get_sorted_matches -> get_sorted_songs chain of
    readers after query: allow up to 2 post-query reader steps (functions taking the query's return,
    producing looks_like_ranking).

## Week 3 spec (benchmarks/week3/language_search_benchmark/roles.py + discovered.py + plugins.discovery())
Fixture: public test tier (75 captions, 20 queries, 100-image pool, k=50) + Resources (glove kv,
captions corpus, descriptors dict). Branches per P4. accepts = run their composed object through
drivers.run_with_adapter on ALL 9 cases; pass iff every case ok AND text embeddings are finite (N,D)
with 8<=D<=512 AND search returns k ids from the pool for every query. Score quality is NOT a gate.
Weights: candidates = any .npy/.npz/.pkl/.pt under the root whose loaded shape is (512,D) or a
[W,b] pair with W (512,D); tiebreak = the path THEIR code names in a string literal (AST scan for
str constants ending in that basename), then refuse-as-ambiguous listing all. Absent weights: per
Fable's counsel (pending) -- default to binding the image branch with the seeded random init and
publishing a diagnostic "no trained weights committed; image side is untrained", unless Fable argues
otherwise. Hash seed: set PYTHONHASHSEED=0 for the discovery subprocess AND the scored run (already
seeded random/numpy); record it on the binding.

## Acceptance for this build (tests, all must fail before / pass after)
- Corpus: W1 4/5 scored (Asterisk refused with "no function stores fingerprints"), W2 4/5 scored
  (rutvim refused naming whispers.py:66), W3 4/4 scored. Every refusal names the furthest step.
- Oracle: every repo with a hand adapter matches it to 4 places (Lashika W2 and W3, carti4ce, Krazee).
- Every supplied thing appears in the binding record and in `cogworks check` output under "supplied".
- Determinism: two cold resolves -> byte-identical to_dict().
- Unit tests per primitive P1-P9 in python/cogbench/tests/test_pipeline.py / test_discover.py.
- All existing suites green; submodule pins advanced.
