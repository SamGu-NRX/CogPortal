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
str constants ending in that basename), then refuse-as-ambiguous listing all. Absent weights (decided, architecture counsel 2026-09-02): the image surfaces are NOT scored and
the overall is WITHHELD and marked partial; never a seeded random W averaged into a composite, because
"text 0.87, image unmeasured" and "overall 0.32" are different claims and only the first is true.
The run page names what is missing in their terms, read statically from their own save call:
"no trained weights in the repository; your train.py saves to results/modelweights.pkl, which is
in .gitignore". Text still scores. A bounded run of THEIR trainer is a later, separate diagnostic
(budget printed on the number, never in the score); not in this build.
Weights tiebreak: ONLY the file their code names in a load call (cite file:line). No "newest by git"
(a squashed clone would bind differently). No literal, or disagreeing literals -> refuse as
ambiguous listing every candidate. A weights file saved at init still binds and scores at chance;
the instrument measures the artifact, not the intent. Hash seed: set PYTHONHASHSEED=0 for the discovery subprocess AND the scored run (already
seeded random/numpy); record it on the binding.

## Acceptance for this build (tests, all must fail before / pass after)
- Corpus: W1 4/5 scored (Asterisk refused with "no function stores fingerprints"), W2 4/5 scored
  (rutvim refused naming whispers.py:66), W3 4/4 scored. Every refusal names the furthest step.
- Oracle: every repo with a hand adapter matches it to 4 places (Lashika W2 and W3, carti4ce, Krazee).
- Every supplied thing appears in the binding record and in `cogworks check` output under "supplied".
- Determinism: two cold resolves -> byte-identical to_dict().
- Unit tests per primitive P1-P9 in python/cogbench/tests/test_pipeline.py / test_discover.py.
- All existing suites green; submodule pins advanced.

## Week 3 wire contract for a withheld overall (decided)
The ProtocolMetricSchema `value` is a number and the driver already scores a missing component as
zero with a diagnostic. A withheld overall therefore does NOT ship a null value; it ships:
- no `overall` metric at all, and the plugin's `primary_metric` resolves to `text_mrr` for that run,
  with a run-level diagnostic first in `last_diagnostics`: "overall withheld: the image side has no
  trained weights to measure. Your training.py saves to results/modelweights.pkl (training.py:113),
  and *.pkl is in .gitignore (line 31). Commit that file and run again." (paths/lines read statically
  from their own save call and .gitignore).
- `retrieval_mrr` and `search_mrr` are omitted (not zero); their floors are still reported.
- The renderer needs nothing new: a run whose primary is `text_mrr` renders as any run does, and the
  diagnostic leads the Finding. A later portal change may add a "partial" chip; not in this build.
The plugin decides this in `submission_from_discovery` + `score`: if the discovered binding has
`weights=None` for the image branch, the built adapter has no embed_images/prepare/search, the driver
records those components as errors, and `score` drops the three image-side keys and `overall`
instead of zeroing them, and prepends the diagnostic.

## Week 3 spec: exact stage design (for the implementer)
Fixture (built lazily in discovery(), COGWORKS_SHOWCASE=0 during probes):
  resources = build_resources(download=False, build_kv=True); cases = load_cases("test")
  text_case (75 captions), retrieval_case (20 queries, 100x512 descriptors), search_case (ids, descriptors, k=50)
  extras pool seeds: glove=resources.load_glove(), corpus=[a["caption"] for a in load_captions()["annotations"]],
                     descriptors_dict=resources.load_descriptors()
Branches (P4), shared extras + instance pools:
  fit "idf":   Stage(fit=True, fixture=(corpus,), produces=looks_like_idf_table)  # dict[str,float] or None
  branch "text": Stage("text", accepts=list_of_str, produces=looks_like_matrix(N), per_item=True,
                       extras=("glove","idf"), fusible=False)
                 # per-item form tokenize->embed is 2 steps for rutvim (caption_processor then embed_text):
                 # allow a 2-stage text chain: Stage("tokens", produces=list_of_str, per_item, optional)
  branch "image": Stage("weights", fit=True, fixture=(root,), produces=looks_like_W)  # (512,D) or [W,b]; see below
                  Stage("image", accepts=(M,512) float, produces=looks_like_matrix(M), extras=("W","weights_model"), per_item=True)
  branch "prepare": Stage("prepare", accepts=(ids, descriptors), produces=any, extras=("W","image_embeddings"), identity=False)
                    # ctor-as-stage (P3): ImageDatabase(ids, desc, W); CaptionImageQuery(EMB, ids) -> so extend must offer
                    # BOTH raw descriptors and the image branch's projected output as the descriptor slot.
  branch "search":  Stage("search", accepts=(str,int), produces=looks_like_id_list, extras=("glove","idf","store"),
                    per_item=False)  # query(vec,k) on the prepare instance; or query_database(vec, db, k) module fn
                    # text->vector is the text branch's chain applied to the query string (reuse, not re-search).
Weights stage detail: candidates are every file under root matching *.npy|*.npz|*.pkl|*.pt|*.pth whose
loaded object is (512,D) float or [W(512,D), b] or a dict/npz holding such; loaded with np.load/pickle in
a subprocess; tiebreak per the decision above (their load-call literal, cite file:line; else refuse
ambiguous listing all). Also a model class with a .load(path) method is a way to apply W (Bagel).
accepts(bound): build the adapter object from the branches, run drivers.run_with_adapter on all 9 test
cases, pass iff every case ok=True and the text matrix is finite; NO score threshold.
discovered.py: DiscoveredSearch(text_chain, image_chain|None, prepare, search, extras) exposing
embed_text/embed_images/prepare_database/search; mygrad Tensor -> .data; search rows of dicts -> 'image_id'.
Hash seed: run_isolated child gets PYTHONHASHSEED=0; the sandbox image env sets PYTHONHASHSEED=0; the
binding records it. Text MRR on rutvim moves 0.83..0.92 with the seed otherwise.

## Engine gaps found by probing the week 3 branches on the corpus (2026-09-02, after cc9bcc9)
Measured with the four-branch role on Lashika: text binds, image refuses "nothing accepted the
input the image step passes". Root causes, each generic:
G1. A branch's OUTPUT never enters the extras pool. Bagel's CaptionImageQuery(EMBEDDINGS, ids)
    takes the image branch's projected matrix; Lashika's search takes the prepare branch's store.
    Fix: after a branch binds, pool[branch.name] = the value its last step produced (Binding gains
    a private _value), and later branches may name it in Stage.extras or in their fixture.
G2. Branch fixtures are fixed at role construction, so a branch cannot be probed with a value
    another branch produced. Fix: Role.fixture may be a callable (pool, chains) -> fixture or
    Fixtures, evaluated when the branch is resolved. Week 3's search branch fixture is
    (text_chain(query), k); its prepare fixture is Fixtures over (ids, descriptors), (descriptors,
    ids), (ids, pool["image"]), (pool["image"], ids).
G3. Branches resolve in declared order once. Lashika's image step is a method of the object the
    PREPARE branch constructs (ImageDatabase(ids, desc, W).descriptor_to_embedding), and Bagel's
    prepare needs the IMAGE branch's output: the two repos need opposite orders. Fix: resolve
    branches to a fixpoint: loop over unresolved branches, resolve any that can, repeat until a
    pass makes no progress. Deterministic (declared order within each pass).
G4. A side input that is itself callable cannot be a step. Bagel's image encoder is
    ImageToCaption() (zero-arg) + .load(their pickle) + __call__; methods_of skips underscore names
    and the loaded instance lives in the pool as "weights_model". Fix: a pool entry named in
    Stage.extras that is callable is offered as a candidate for that stage, labeled by the extra's
    name plus the object's class, recorded as supplied (the week says what it loaded and from where).
G5. The hand-off the search chose between two steps (whole value, spread, reversed, element k) is
    described in _Partial.received but not recorded on the Candidate, so a scored run re-derives it
    or guesses. Same defect class as tuning/form/in_place, fixed the same way: Candidate.handoff
    (None | "spread" | "reversed" | "element:k"), applied by bound()/_invoke, stored in the memo
    (FORMAT 8), replayed. Week 1's _run re-derivation in the uncommitted week1 tree must then go.
G6. One failing branch refuses the whole role. Under the withheld-overall decision a week-3 repo
    with no weights must still bind text. Fix: Role.optional on a branch; a required branch failing
    refuses the role; an optional one failing is recorded on the binding as
    Binding.missing[name] = Refusal and the role proceeds. Submission.to_dict carries "missing".

## Engine gaps found running the four-branch role end to end (2026-09-02, after G1-G6)
Each measured on the corpus with the full role, each fixed generically, each with a unit test.
G7. The repository's own contribution to the pool. Week 3's trained W is a file the team committed,
    so `discovery()` (built before any repository is chosen) cannot hold it, and every repository read
    as having no weights with `data/W_embed.npy` in the tree. `DiscoverySpec.prepare(root, modules)`
    runs after the root is chosen, and its result is merged UNDER the benchmark's extras. A hook that
    raises refuses the search with its own words.
G8. The call clock could escape. `_call` cancelled the alarm in the outer `finally`, outside the
    `except`, so a `_Timeout` raised between the student call returning and the cancel left `_call`
    and ended the whole search (CogFinder: `Search(model)` takes exactly ten seconds). The cancel now
    sits inside the guarded block.
G9. A value their module computes at load can answer a fit stage. rutvim has no IDF function; the
    table is a module-scope loop and every embedding call reads the global. `values_in` offers
    module-scope data, only after every function has been tried, recorded as "read from
    text_to_image.idf, a value their module computes when it loads".
G10. A whole-list call that answers with the WRONG shape hid the per-item form. CogFinder's
    `tokenize(text)` walks characters; handed 75 captions it returned one flat list, the call had
    "succeeded", and the per-item form was never tried. `_bind_one` now tries the per-item form when
    the whole answer fails `produces` and keeps it only when it passes.
G11. A stem the root already owns was skipped, not read. Bagel's root `image_caption_model.py` has no
    `load`; `model_tests/image_caption_model.py`, the one their scripts import and the only encoder
    that reads their weights, was never read. Shadowed files load under `folder.stem`; the root keeps
    the bare name and import precedence; a folder that is not an identifier (`Day 4`) is still skipped.
G12. A DECLARED week root read the sibling weeks. With `Week3` declared, rutvim's week 2
    `facerecognizer.cosine_threshold` bound as the week 3 store. The matched-week rule (read only what
    lives under the chosen week) now covers a declared one.

Week 3 rules that changed in the same pass:
- A load call under a module-scope guard that is statically false does not run
  (`_dead_when_loaded`): Bagel's `test_db.py` sets `t = 0` and loads `test1.pkl` under `elif t == 1`.
  Guards the folder cannot decide (`__main__`, a name bound by a call) count as running.
- A table whose every weight is a whole number is a count table, not an IDF table; the first draft
  accepted ints, so its own docstring was untrue.
- Their model object (`roles.loaded_model`): a zero-argument class of theirs with `load(path)` that
  accepts the file AND encodes a (1, 512) probe afterwards is put in the pool as `weights_model`.
- Ambiguous weights withhold the image side (with the competing files named) rather than refusing
  the repository: a text side that works is not thrown away over a question about the image side.

## Engine gaps found running the corpus end to end again (2026-09-03)
G13. A branch was judged only when every branch was in. Lashika's image branch first bound
    `triplet_utils.train_val_split` (a (100, 409) matrix passes the loose width check), the week's
    test refused the whole, and the role was reported ran-but-wrong while `descriptor_to_embedding`
    was never asked. Each branch is now judged as it binds, beside the branches bound so far, and a
    rejected chain is passed over for the next one in the frontier.
G14. A branch bound on the first fixture form its function accepted, with no way back. Bagel's
    `CaptionImageQuery(image_embeddings, image_ids)` constructs with the arguments swapped and only its
    `search`, one branch later, can tell. `_resolve_branches` now backtracks over forms: when a
    branch whose input existed still could not bind, the last-bound branch with a form not yet tried
    is bound again without it and everything after it is searched again; bounded by the number of
    forms; the attempt that binds the most branches wins.
G15. A fusible stage could only be absorbed by the step BEFORE it (their function produced this
    stage's output). Cog-gurts' `fingerprint_recording(spectrogram)` finds the peaks and pairs them,
    and their separate `local_peak_locations` needs a neighbourhood array and an amplitude floor no
    benchmark can supply. The stage's INPUT is now also handed to the following stage's candidates
    (recorded as "peaks + fingerprints"), governed by this stage's `accepts`, only where nothing of
    theirs served the stage, never into an in-place following stage, and asked after every chain
    that found a function for the stage (`_Partial.forward`).
G16. The folder dry call ran once per fixture form per folder-declaring stage. CoggurtFilter's
    `clusterCreator()` builds FaceNet and describes 34 photos on every call. Memoized per constructor
    per search; the stage's own output check stays per stage.
G17. `bound()` did not replay `in_place`: a step recorded as answering on its argument handed the next
    step None in a scored run. No week had witnessed it (week 2 replays through its own `_run`).
G18. Week 2 and week 3 leaked one scratch directory per resolve (`write_photos`, week 1's
    `mkdtemp`); a corpus pass filled the disk. Removed at process exit.
G19. The ran-but-wrong headline hard-coded week 2's sentence ("answered a different grouping where
    the answer is one group per person") and a week 3 team read it about their caption search.
    `DiscoverySpec.expects` carries the week's own words and the headline quotes what the week's
    test said.
G20. A store that forgot the images bound as week 3's prepare step (CogFinder's
    `generate_letter(ids, descriptors)` returned a letter). `looks_like_store_of(ids)` requires the
    ids, or one row per id, somewhere in the value to depth two.
G21. A text embedder that maps every caption to one vector passed week 3's test (CogFinder's
    `tokenize -> embed_caption` re-tokenizes the token list into one unknown word). Refused when
    all rows are equal; not a score threshold.

Week 3 policy addition: a bound image side with no bound search side withholds `search_mrr` and
the overall, leads with `retrieval_mrr`, and names the search step's refusal. Bagel's first
end-to-end run had scored search 0.0 into an overall of 0.4183.

Known refusals that stand, with the reason a student would read:
- CoggurtFilter (week 2): `clusterCreator()` reads `baseImages/` next to their code through
  `Path(__file__)`, so a folder of the benchmark's photos cannot be handed to it; skipping their
  constructor (`__new__`) is a decision about their design, not a binding. Their
  `detect_and_describe(model, image)` needs the benchmark's model as a LEADING extra, which the week
  2 spec does not yet declare; once it does, the refusal should name the constructor's folder read.
- rutvim week 2: `whispers.py:1` shadows the model; refused at the first broken line.
- Asterisk week 1: no function stores fingerprints.

Review findings on the above (fresh Sol, 2026-09-03), all fixed the same night with a test each:
form backtracking now a bounded depth-first search over form prefixes (a ban under one upstream
state never carries to another; best attempt by required branches covered, then all branches);
`loaded_model` runs the constructor, loader, and a probe call under the search's clock and the
prepare hook runs from the scratch directory; week 3's `_run` makes each call exactly once through
`bound` (the element-0 retry was a call the search never proved); a student file never takes a
dotted name that already exists and a displaced module is put back when discovery leaves;
skipped readings share the beam with their parents in one share-out; a wrong whole-list answer
moves to the next shape instead of ending the candidate; `retrieval_median_rank` is withheld with
the image side; guard folding short-circuits `and`/`or` and walks an unknown `if` from a copy per
branch; in-place replay covers the self-only, cross-branch, and per-item paths; the showcase
environment variable is restored after each acceptance run.

Two corrections after the review round, both measured: the dotted-name guard is judged against the
modules present BEFORE discovery entered (Bagel's own scripts import `model_tests.image_caption_model`
before its file is reached, and the live table hid the encoder that loads their weights); only an
INSTALLED displaced module is put back on leave (another repository's hand adapter leaves a bare
`database` behind, and restoring it handed the next adapter the wrong team's code: carti4ce's oracle
scored 0.0 after KrazeeCoder's test).
