from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.pipeline import (
    Candidate,
    Fixtures,
    Role,
    Stage,
    callables_in,
    extend,
    probe_sources,
    resolve_chain,
)


def _module(name: str, **members) -> ModuleType:
    module = ModuleType(name)
    for key, value in members.items():
        if callable(value):
            value.__module__ = name
        setattr(module, key, value)
    return module


# A miniature of the week 1 pipeline, in the shape the real one has: a source
# that takes the benchmark's own input, then two stages reachable only by
# feeding the previous stage's real output forward.
def _spectrogram(samples, rate):
    return [[float(value) * rate for value in samples]] * 4


def _peaks(spec):
    return [(row, column) for row in range(len(spec)) for column in range(2)]


def _fanout(peaks):
    return [((a[0], b[0], b[1] - a[1]), a[1]) for a, b in zip(peaks, peaks[1:])]


def _two_d(value):
    """Loose, but a spectrogram has more than one column per row."""

    return (
        isinstance(value, list)
        and value
        and isinstance(value[0], list)
        and len(value[0]) > 2
    )


def _pairs(value):
    return isinstance(value, list) and value and len(value[0]) == 2


def _fingerprints(value):
    return isinstance(value, list) and value and isinstance(value[0][0], tuple)


ROLE = Role(
    "fingerprint",
    (
        Stage("spectrogram", prefers=("spectrogram",), produces=_two_d, arity=2),
        Stage("peaks", prefers=("peak",), produces=_pairs),
        Stage("fanout", prefers=("fingerprint", "fanout"), produces=_fingerprints),
    ),
)

FIXTURE = ([0.1, 0.2, 0.3, 0.4], 44100)


class CandidateTests(unittest.TestCase):
    def test_imported_symbols_are_not_candidates(self):
        """A team that imports maximum_filter did not write a peak finder."""

        from math import sqrt

        module = _module("theirs", ours=lambda x: x)
        module.sqrt = sqrt

        labels = [candidate.label for candidate in callables_in([module])]

        self.assertEqual(labels, ["theirs.ours"])

    def test_helpers_that_only_draw_or_test_are_skipped(self):
        module = _module(
            "theirs",
            plot_spectrogram=lambda x: x,
            test_peaks=lambda x: x,
            find_peaks=lambda x: x,
        )
        labels = [candidate.label for candidate in callables_in([module])]
        self.assertEqual(labels, ["theirs.find_peaks"])

    def test_a_function_that_leaves_the_process_is_never_called(self):
        """Probing one repository's mp3 splitter loads a second copy of soxr
        and aborts the interpreter, which no caller can catch."""

        source = "def split(path):\n    from pydub import AudioSegment\n    return AudioSegment\n"
        namespace: dict = {}
        exec(compile(source, "theirs.py", "exec"), namespace)
        module = _module("theirs", split=namespace["split"])

        self.assertEqual(callables_in([module]), [])


class ChainTests(unittest.TestCase):
    def test_a_full_chain_resolves_without_any_name_matching(self):
        module = _module(
            "anything",
            alpha=_spectrogram,
            beta=_peaks,
            gamma=_fanout,
        )
        binding, refusal = resolve_chain(ROLE, [module], FIXTURE)

        self.assertIsNone(refusal)
        self.assertEqual(
            binding.describe(),
            [
                "spectrogram <- anything.alpha",
                "peaks <- anything.beta",
                "fanout <- anything.gamma",
            ],
        )

    def test_names_change_the_order_tried_and_never_the_result(self):
        """The litmus test: emptying every preference must not change what
        binds. If a name were load-bearing it would have become a gate."""

        module = _module("anything", alpha=_spectrogram, beta=_peaks, gamma=_fanout)
        blind = Role(
            ROLE.name,
            tuple(
                Stage(stage.name, (), stage.accepts, stage.produces, stage.arity)
                for stage in ROLE.stages
            ),
        )

        with_names, _ = resolve_chain(ROLE, [module], FIXTURE)
        without_names, _ = resolve_chain(blind, [module], FIXTURE)

        self.assertEqual(with_names.steps, without_names.steps)

    def test_a_stage_output_is_offered_whole_and_then_unpacked(self):
        """Their spectrogram often comes back as (spec, freqs, times) and their
        own peak finder takes the array."""

        def triple(samples, rate):
            return (_spectrogram(samples, rate), [1, 2], [3, 4])

        def spec_or_triple(value):
            return _two_d(value[0] if isinstance(value, tuple) and value else value)

        role = Role(
            ROLE.name,
            (Stage("spectrogram", ("spectrogram",), None, spec_or_triple, 2),)
            + ROLE.stages[1:],
        )
        module = _module("anything", make=triple, peaks=_peaks, fan=_fanout)
        binding, refusal = resolve_chain(role, [module], FIXTURE)

        self.assertIsNone(refusal)
        self.assertEqual(binding.steps[1].label, "anything.peaks")

    def test_nothing_is_rescaled_between_stages(self):
        """Their threshold is tuned to their own scaling: one repository
        returns an already-logged spectrogram, and logging it again produced
        NaNs and zero peaks."""

        seen = {}

        def source(samples, rate):
            value = _spectrogram(samples, rate)
            seen["produced"] = value
            return value

        def sink(spec):
            seen.setdefault("received", spec)
            return _peaks(spec)

        module = _module("anything", source=source, sink=sink, fan=_fanout)
        binding, _ = resolve_chain(ROLE, [module], FIXTURE)

        self.assertIsNotNone(binding)
        self.assertIs(seen["received"], seen["produced"])

    def test_a_plausible_wrong_binding_is_refused_by_the_next_stage(self):
        """Measured on real code: find_peaks accepts raw audio and returns a
        (440, 1) array that any shape check accepts. The chain is what tells
        the truth."""

        def looks_right_but_is_not(samples, rate):  # noqa: ARG001
            return [[1.0], [2.0]]

        module = _module("anything", trap=looks_right_but_is_not)
        binding, refusal = resolve_chain(ROLE, [module], FIXTURE)

        self.assertIsNone(binding)
        self.assertEqual(refusal.stage, "spectrogram")

    def test_the_refusal_names_the_furthest_point_reached(self):
        module = _module("anything", alpha=_spectrogram, beta=_peaks)
        binding, refusal = resolve_chain(ROLE, [module], FIXTURE)

        self.assertIsNone(binding)
        self.assertEqual(refusal.stage, "fanout")
        self.assertEqual(refusal.furthest, ("anything.alpha", "anything.beta"))
        self.assertIn("anything.beta", refusal.detail)

    def test_a_chain_that_runs_but_answers_wrongly_is_still_refused(self):
        module = _module("anything", alpha=_spectrogram, beta=_peaks, gamma=_fanout)

        binding, refusal = resolve_chain(
            ROLE, [module], FIXTURE, verify=lambda chain: False
        )

        self.assertIsNone(binding)
        self.assertIn("did not return the right answer", refusal.detail)

    def test_an_empty_repository_refuses_at_the_first_stage(self):
        binding, refusal = resolve_chain(ROLE, [], FIXTURE)
        self.assertIsNone(binding)
        self.assertEqual(refusal.detail, "no functions to try")

    def test_a_function_that_raises_is_simply_not_a_candidate(self):
        def angry(samples, rate):  # noqa: ARG001
            raise ValueError("not this one")

        module = _module("anything", angry=angry, alpha=_spectrogram, beta=_peaks, gamma=_fanout)
        binding, _ = resolve_chain(ROLE, [module], FIXTURE)

        self.assertEqual(binding.steps[0].label, "anything.alpha")

    def test_resolution_is_the_same_every_time(self):
        module = _module("anything", alpha=_spectrogram, beta=_peaks, gamma=_fanout)
        first, _ = resolve_chain(ROLE, [module], FIXTURE)
        second, _ = resolve_chain(ROLE, [module], FIXTURE)
        self.assertEqual(first.steps, second.steps)


class ContainmentTests(unittest.TestCase):
    """Probing calls student code, and student code writes."""

    def test_a_function_that_writes_beside_itself_does_not_touch_the_caller(self):
        """One audited repository keeps a module-global relative db.pkl and
        rewrites it on every add. Probing two repositories left db.pkl and
        songs.pkl in this checkout before this was contained."""

        def leaky(samples, rate):
            Path("db.pkl").write_bytes(b"student state")
            return _spectrogram(samples, rate)

        module = _module("anything", leaky=leaky, beta=_peaks, gamma=_fanout)
        before = set(Path.cwd().iterdir())

        resolve_chain(ROLE, [module], FIXTURE)

        self.assertEqual(set(Path.cwd().iterdir()), before)

    def test_the_working_directory_is_restored(self):
        module = _module("anything", alpha=_spectrogram, beta=_peaks, gamma=_fanout)
        before = Path.cwd()
        resolve_chain(ROLE, [module], FIXTURE)
        self.assertEqual(Path.cwd(), before)


class StageProbeTests(unittest.TestCase):
    def test_probe_sources_only_keeps_what_returns_the_right_shape(self):
        module = _module(
            "anything",
            good=_spectrogram,
            wrong=lambda samples, rate: "not a spectrogram",  # noqa: ARG005
        )
        hits = probe_sources(ROLE.stages[0], callables_in([module]), FIXTURE)
        self.assertEqual([candidate.label for candidate, _ in hits], ["anything.good"])

    def test_extend_feeds_the_real_upstream_value(self):
        module = _module("anything", beta=_peaks)
        spec = _spectrogram(*FIXTURE)
        hits = extend(ROLE.stages[1], callables_in([module]), spec)
        self.assertEqual([candidate.label for candidate, _, _ in hits], ["anything.beta"])
        self.assertIs(hits[0][2], spec)



class ShapesTheCorpusActuallyWrote(unittest.TestCase):
    """Four ways a team can divide the same work, each found in the 2026
    repositories, and each refused before the search could express it."""

    def test_one_function_may_be_called_once_per_item(self):
        """Week 2's capstone hands students one photo at a time, so every
        audited team wrote a per-photo descriptor function while the benchmark
        works on a folder."""

        module = _written(
            "theirs",
            "def describe(one):\n    return [float(one), 0.0]\n",
        )
        stage = Stage("d", produces=lambda v: isinstance(v, list), per_item=True)

        found = probe_sources(stage, callables_in([module]), ([1, 2, 3],))

        self.assertEqual([c.label for c, _ in found], ["theirs.describe"])

    def test_a_partial_item_failure_is_not_a_binding(self):
        """A descriptor function that works on eleven photos of twelve has
        not done the job."""

        module = _written(
            "theirs",
            "def describe(one):\n"
            "    if one == 2:\n        raise ValueError('no face')\n"
            "    return [float(one)]\n",
        )
        stage = Stage("d", produces=lambda v: isinstance(v, list), per_item=True)

        self.assertEqual(probe_sources(stage, callables_in([module]), ([1, 2, 3],)), [])

    def test_a_benchmark_may_offer_its_input_in_more_than_one_form(self):
        """The course tells students to write a function taking image paths,
        so an arrays-only fixture refused every team that followed it."""

        module = _written("theirs", "def load(paths):\n    return [len(str(p)) for p in paths]\n")
        stage = Stage("d", produces=lambda v: isinstance(v, list))
        fixture = Fixtures((([[1, 2]],), (["a.png", "b.png"],)))

        found = probe_sources(stage, callables_in([module]), fixture)

        self.assertEqual([c.label for c, _ in found], ["theirs.load"])

    def test_a_returned_pair_may_be_the_next_function_s_arguments(self):
        """The course's own design returns "a list of nodes and an adjacency
        graph ... together", and the next function takes both."""

        module = _written(
            "theirs",
            "def build(x):\n    return ([1, 2], {'a': 1})\n"
            "def run(nodes, adj):\n    return [len(nodes), len(adj)]\n",
        )
        candidates = callables_in([module])
        graph = Stage("g", produces=lambda v: isinstance(v, tuple))
        labels = Stage("l", produces=lambda v: isinstance(v, list) and len(v) == 2)

        built = probe_sources(graph, candidates, (0,))
        self.assertTrue(built)
        extended = extend(labels, candidates, built[0][1])

        self.assertEqual([c.label for c, _, _ in extended], ["theirs.run"])

    def test_a_required_tuning_argument_is_offered_the_benchmark_s_values(self):
        """The course tells students to pick a cutoff by eye, so their graph
        builders take one with no default."""

        module = _written("theirs", "def build(items, threshold):\n    return [threshold] * len(items)\n")
        stage = Stage("g", produces=lambda v: isinstance(v, list), tunings=(0.5,))

        found = probe_sources(stage, callables_in([module]), ([1, 2],))

        self.assertEqual([c.label for c, _ in found], ["theirs.build"])
        self.assertEqual(found[0][1], [0.5, 0.5])

    def test_a_function_with_a_default_is_not_given_a_tuning(self):
        """A team who chose their own value keeps it."""

        module = _written("theirs", "def build(items, threshold=0.9):\n    return [threshold]\n")
        stage = Stage("g", produces=lambda v: isinstance(v, list), tunings=(0.5,))

        found = probe_sources(stage, callables_in([module]), ([1, 2],))

        self.assertEqual(found[0][1], [0.9])


def _written(name, source):
    """A module from literal source, the way a student's file arrives."""

    module = ModuleType(name)
    exec(compile(source, name, "exec"), module.__dict__)
    return module

if __name__ == "__main__":
    unittest.main()


class TuningIsPartOfTheBinding(unittest.TestCase):
    """The value that made a step run is the value it runs with afterwards.

    A chain the search accepted is handed to the week's acceptance test and
    then to the driver. Both call the steps again. If the tuning the search
    found is not on the step, those calls are made without it, and a function
    that needed one raises on its first call. Measured on one 2026 repository
    before this existed: the search bound `adj_list(paths, threshold)` at
    0.3, the acceptance test called `adj_list(paths)`, and the report said
    their code ran and answered wrongly. It had not run.
    """

    def test_a_probed_source_carries_the_tuning_that_bound_it(self):
        module = _written("theirs", "def build(items, threshold):\n    return [threshold] * len(items)\n")
        stage = Stage("g", produces=lambda v: isinstance(v, list), tunings=(0.5,))

        (candidate, _value), = probe_sources(stage, callables_in([module]), ([1, 2],))

        self.assertEqual(candidate.tuning, 0.5)
        self.assertEqual(candidate.bound([1, 2, 3]), [0.5, 0.5, 0.5])

    def test_a_plain_call_that_worked_carries_no_tuning(self):
        module = _written("theirs", "def build(items, threshold=0.9):\n    return [threshold]\n")
        stage = Stage("g", produces=lambda v: isinstance(v, list), tunings=(0.5,))

        (candidate, _value), = probe_sources(stage, callables_in([module]), ([1, 2],))

        self.assertIsNone(candidate.tuning)
        self.assertIs(candidate.bound, candidate.call)

    def test_an_extended_step_carries_the_tuning_that_bound_it(self):
        module = _written("theirs", "def grow(value, cutoff):\n    return [value, cutoff]\n")
        stage = Stage("g", produces=lambda v: isinstance(v, list), tunings=(3, 7))

        extended = extend(stage, callables_in([module]), 1)

        self.assertEqual(len(extended), 1)
        candidate, value, _passed = extended[0]
        self.assertEqual(value, [1, 3])
        self.assertEqual(candidate.tuning, 3)

    def test_the_bound_chain_reruns_with_the_same_tunings(self):
        """The whole point: calling `bound` on every step of a resolved chain
        reproduces the search's own run, which is what a verifier must see."""

        module = _written(
            "theirs",
            "def first(items, threshold):\n    return [i * threshold for i in items]\n"
            "def second(values):\n    return [v + 1 for v in values]\n",
        )
        role = Role(
            "r",
            (
                Stage("a", produces=lambda v: isinstance(v, list), tunings=(2,)),
                Stage("b", produces=lambda v: isinstance(v, list)),
            ),
        )
        seen = []

        def verify(steps):
            value = steps[0].bound([1, 2])
            for step in steps[1:]:
                value = step.bound(value)
            seen.append(value)
            return value == [3, 5]

        binding, refusal = resolve_chain(role, [module], ([1, 2],), verify=verify)

        self.assertIsNone(refusal)
        self.assertEqual(seen, [[3, 5]])
        self.assertEqual([s.tuning for s in binding.steps], [2, None])


class TheFormThatBoundIsPartOfTheBinding(unittest.TestCase):
    """When a benchmark offers its input in two forms, the chain remembers
    which one its first step accepted, so the acceptance test and the scored
    run present that one. Measured on two 2026 repositories: both bound on
    paths, both were then handed arrays, and both were reported as having
    run and answered wrongly when they had raised on the first line."""

    def test_the_form_index_is_recorded_on_the_first_step(self):
        # `.rsplit` exists on a str and not on a list, so the arrays form
        # raises and only the paths form binds.
        module = _written("theirs", "def load(paths):\n    return [p.rsplit('.', 1)[1] for p in paths]\n")
        stage = Stage("d", produces=lambda v: isinstance(v, list))
        fixture = Fixtures((([[1, 2]],), (["a.png", "b.png"],)))

        (candidate, _value), = probe_sources(stage, callables_in([module]), fixture)

        self.assertEqual(candidate.form, 1)
        self.assertEqual(fixture.for_chain([candidate]), (["a.png", "b.png"],))

    def test_a_single_form_records_no_index_and_for_chain_returns_it(self):
        module = _written("theirs", "def load(items):\n    return list(items)\n")
        stage = Stage("d", produces=lambda v: isinstance(v, list))

        (candidate, _value), = probe_sources(stage, callables_in([module]), ([1, 2],))

        self.assertIsNone(candidate.form)
        self.assertEqual(Fixtures((([1, 2],),)).for_chain([candidate]), ([1, 2],))


class AnInPlaceStepIsNotStarvedByLookalikes(unittest.TestCase):
    """At an in-place stage the beam keeps the step that answered on the
    graph ahead of steps whose return merely looks like the answer."""

    def test_the_in_place_chain_survives_a_narrow_beam(self):
        module = _written(
            "theirs",
            # `build` takes ints only, so it cannot pose as a settle step.
            "def build(items):\n    return [{'label': int(i)} for i in items]\n"
            "def decoy_a(graph):\n    return [9, 9, 9]\n"
            "def decoy_b(graph):\n    return [8, 8, 8]\n"
            "def settle(graph):\n"
            "    for node in graph: node['label'] = 0\n"
            "    return 'done'\n"
            "def read(graph):\n    return [node['label'] for node in graph]\n",
        )
        graph = lambda v: isinstance(v, list) and bool(v) and isinstance(v[0], dict)
        ints = lambda v: isinstance(v, list) and bool(v) and all(isinstance(i, int) for i in v)
        # Only the last stage knows how many answers there must be, as
        # Week 2's `cluster_role_for` does. The decoys pass the loose
        # settle predicate and take beam slots there, which is the
        # starvation; they fail the sized one at the end.
        role = Role(
            "r",
            (
                Stage("graph", produces=graph),
                Stage("settle", prefers=("decoy",), produces=ints, in_place=True),
                Stage("labels", produces=lambda v: ints(v) and len(v) == 3 and v != [9, 9, 9] and v != [8, 8, 8]),
            ),
        )

        binding, refusal = resolve_chain(role, [module], ([1, 2, 3],), beam=2)

        self.assertIsNone(refusal)
        self.assertEqual([s.label for s in binding.steps], ["theirs.build", "theirs.settle", "theirs.read"])
        self.assertEqual([s.in_place for s in binding.steps], [False, True, False])


class SideInputsTheirCodeCannotMake(unittest.TestCase):
    """P1. Some arguments are data the benchmark owns and the search cannot
    produce: week 3's GloVe vectors, week 2's FaceNet model. A stage names
    them and they are tried after the value, before it, and by keyword,
    because the corpus writes all three."""

    def test_a_side_input_is_offered_after_the_value(self):
        """Lashika's week 3 `embed_captions_batch(texts, glove, idfs)`."""

        module = _written(
            "theirs",
            "def embed(texts, glove, idfs):\n"
            "    return [glove[t] * idfs[t] for t in texts]\n",
        )
        stage = Stage(
            "text",
            produces=lambda v: isinstance(v, list),
            extras=("glove", "idfs"),
        )
        pool = {"glove": {"a": 2, "b": 3}, "idfs": {"a": 10, "b": 100}}

        found = probe_sources(
            stage, callables_in([module]), (["a", "b"],), extras=pool
        )

        self.assertEqual([c.label for c, _ in found], ["theirs.embed"])
        self.assertEqual(found[0][1], [20, 300])
        self.assertEqual(found[0][0].plan, ("value", "extra:glove", "extra:idfs"))

    def test_a_side_input_is_offered_before_the_value(self):
        """CoggurtFilter's week 2 `detect_and_describe(model, image)` takes
        the benchmark's FaceNet model as its FIRST argument."""

        # Their real one calls a method on the model, so handing it the photo
        # first raises rather than returning something plausible. The fake
        # says the same thing the short way.
        module = _written(
            "theirs",
            "def describe(model, image):\n"
            "    return [model.upper(), image]\n",
        )
        stage = Stage("d", produces=lambda v: isinstance(v, list), extras=("model",))

        found = probe_sources(
            stage, callables_in([module]), (0,), extras={"model": "facenet"}
        )

        self.assertEqual(found[0][1], ["FACENET", 0])
        self.assertEqual(found[0][0].plan, ("extra:model", "value"))

    def test_a_side_input_is_offered_by_the_name_the_signature_uses(self):
        module = _written(
            "theirs",
            "def embed(texts, *, idfs):\n    return [idfs[t] for t in texts]\n",
        )
        stage = Stage("t", produces=lambda v: isinstance(v, list), extras=("idfs",))

        found = probe_sources(
            stage, callables_in([module]), (["a"],), extras={"idfs": {"a": 5}}
        )

        self.assertEqual(found[0][1], [5])
        self.assertEqual(found[0][0].keywords, ("idfs",))

    def test_the_bound_step_reruns_with_the_same_side_inputs(self):
        """The whole point of recording the plan: the acceptance test and the
        scored run call the step again, and a step re-called without the
        resource it needed raises on its first line."""

        module = _written(
            "theirs", "def embed(texts, glove):\n    return [glove[t] for t in texts]\n"
        )
        stage = Stage("t", produces=lambda v: isinstance(v, list), extras=("glove",))

        (candidate, _value), = probe_sources(
            stage, callables_in([module]), (["a"],), extras={"glove": {"a": 1, "z": 9}}
        )

        self.assertEqual(candidate.bound(["z"]), [9])

    def test_a_stage_that_declares_nothing_is_called_exactly_as_before(self):
        module = _written("theirs", "def make(items):\n    return list(items)\n")
        stage = Stage("d", produces=lambda v: isinstance(v, list))

        (candidate, _value), = probe_sources(
            stage, callables_in([module]), ([1, 2],), extras={"glove": object()}
        )

        self.assertEqual(candidate.plan, ())
        self.assertIs(candidate.bound, candidate.call)


class AStageComputedOnceAndHandedOn(unittest.TestCase):
    """P2. All four week 3 repositories compute an inverse-document-frequency
    table from the whole caption corpus and pass it to every embedding call.
    It is not a link in the chain: nothing downstream takes it as input."""

    def test_a_fit_stage_runs_against_its_own_input_and_joins_the_pool(self):
        module = _written(
            "theirs",
            "def compute_idfs(corpus):\n"
            "    return {word: len(corpus) for word in corpus}\n"
            "def embed(texts, idfs):\n    return [idfs[t] for t in texts]\n",
        )
        role = Role(
            "search",
            (
                Stage(
                    "idfs",
                    fit=True,
                    fixture=(["a", "b", "c"],),
                    produces=lambda v: isinstance(v, dict),
                ),
                Stage("text", produces=lambda v: isinstance(v, list), extras=("idfs",)),
            ),
        )

        binding, refusal = resolve_chain(role, [module], (["a"],))

        self.assertIsNone(refusal)
        self.assertEqual([s.label for s in binding.steps], ["theirs.embed"])
        self.assertEqual([name for name, _ in binding.fits], ["idfs"])
        self.assertEqual(binding.fits[0][1].label, "theirs.compute_idfs")

    def test_a_fit_stage_nothing_produces_refuses_and_names_itself(self):
        module = _written("theirs", "def embed(texts, idfs):\n    return [1]\n")
        role = Role(
            "search",
            (
                Stage(
                    "idfs",
                    fit=True,
                    fixture=(["a"],),
                    produces=lambda v: isinstance(v, dict),
                ),
                Stage("text", produces=lambda v: isinstance(v, list), extras=("idfs",)),
            ),
        )

        binding, refusal = resolve_chain(role, [module], (["a"],))

        self.assertIsNone(binding)
        self.assertEqual(refusal.stage, "idfs")


class AClassThatDemandsItsDataIsAStep(unittest.TestCase):
    """P3. `instances_in` builds only the classes that construct for free, so
    week 3's `ImageDatabase(ids, descriptors, W)` and week 2's
    `Whispers(vectors, names, threshold)` were never built and their methods
    were never candidates."""

    def test_a_constructor_binds_and_its_methods_serve_later_stages(self):
        module = _written(
            "theirs",
            "class Store:\n"
            "    def __init__(self, rows):\n        self.rows = list(rows)\n"
            "    def ids(self):\n        return [r * 2 for r in self.rows]\n",
        )
        role = Role(
            "search",
            (
                Stage("prepare", produces=lambda v: hasattr(v, "rows")),
                Stage("query", produces=lambda v: isinstance(v, list)),
            ),
        )

        binding, refusal = resolve_chain(role, [module], ([1, 2],))

        self.assertIsNone(refusal)
        self.assertEqual(
            [s.label for s in binding.steps], ["theirs.Store", "theirs.Store.ids"]
        )
        self.assertTrue(binding.steps[1].self_only)
        self.assertEqual(binding.steps[1].bound(None), [2, 4])

    def test_a_class_that_builds_for_free_is_still_left_to_instances_in(self):
        from cogbench.pipeline import constructors_in

        module = _written(
            "theirs", "class Bag:\n    def __init__(self):\n        self.x = 1\n"
        )
        self.assertEqual(constructors_in([module]), [])

    def test_a_method_of_a_built_object_can_build_another_the_same_way(self):
        """A scored run must not start from the object the search filled."""

        module = _written(
            "theirs",
            "class Store:\n"
            "    def __init__(self, rows):\n        self.rows = list(rows)\n"
            "    def ids(self):\n        return list(self.rows)\n",
        )
        role = Role(
            "search",
            (
                Stage("prepare", produces=lambda v: hasattr(v, "rows")),
                Stage("query", produces=lambda v: isinstance(v, list)),
            ),
        )

        binding, _refusal = resolve_chain(role, [module], ([1, 2],))
        again = binding.steps[1].rebuild()

        self.assertEqual(again(), [1, 2])
        self.assertIsNot(again.__self__, binding.steps[1].call.__self__)

    def test_a_method_that_answers_on_the_object_carries_it_forward(self):
        """Week 2's Bagel builds its graph with two methods that return
        nothing and change the object."""

        module = _written(
            "theirs",
            "class Whispers:\n"
            "    def __init__(self, rows):\n"
            "        self.rows = list(rows)\n        self.labels = []\n"
            "    def settle(self):\n"
            "        self.labels = [0 for _ in self.rows]\n"
            "    def read(self):\n        return list(self.labels)\n",
        )
        role = Role(
            "cluster",
            (
                Stage("graph", produces=lambda v: hasattr(v, "rows")),
                Stage("settle", produces=lambda v: isinstance(v, list), in_place=True),
                Stage("labels", produces=lambda v: isinstance(v, list) and len(v) == 2),
            ),
        )

        binding, refusal = resolve_chain(role, [module], ([1, 2],))

        self.assertIsNone(refusal)
        self.assertEqual(
            [s.label for s in binding.steps],
            ["theirs.Whispers", "theirs.Whispers.settle", "theirs.Whispers.read"],
        )
        self.assertTrue(binding.steps[1].in_place)

    def test_a_constructed_step_never_outranks_a_function_that_answered(self):
        """Measured the moment classes became candidates: one 2026 team's
        `Profile(name)` accepted the groups their `connected_components` had
        just returned and added a step that builds a profile and discards
        it."""

        module = _written(
            "theirs",
            "def group(items):\n"
            "    return [[i + 1] for i in items]\n"
            "class Profile:\n"
            "    def __init__(self, name):\n        self.name = name\n",
        )
        groups = lambda v: isinstance(v, list) and bool(v) and isinstance(v[0], list)
        role = Role(
            "cluster",
            (
                Stage("graph", produces=groups),
                Stage("settle", produces=groups, in_place=True, fusible=True),
                Stage("labels", produces=groups, fusible=True),
            ),
        )

        binding, refusal = resolve_chain(role, [module], ([1, 2],))

        self.assertIsNone(refusal)
        self.assertEqual([s.label for s in binding.steps], ["theirs.group"])


class ARoleMadeOfBranches(unittest.TestCase):
    """P4. Week 3 is four surfaces sharing one IDF table and one store, not
    one line."""

    def test_each_branch_resolves_over_the_shared_pool_and_verify_sees_both(self):
        module = _written(
            "theirs",
            "def compute_idfs(corpus):\n    return {w: 1 for w in corpus}\n"
            "def embed_text(texts, idfs):\n"
            "    return [('t', t.upper()) for t in texts]\n"
            "def embed_image(rows, idfs):\n"
            "    return [('i', r + 1) for r in rows]\n",
        )
        pairs = lambda v: isinstance(v, list) and bool(v) and isinstance(v[0], tuple)
        role = Role(
            "search",
            (),
            branches=(
                Role(
                    "text",
                    (Stage("text", produces=pairs, extras=("idfs",)),),
                    fixture=(["a", "b"],),
                ),
                Role(
                    "image",
                    (Stage("image", produces=pairs, extras=("idfs",)),),
                    fixture=([1, 2],),
                ),
            ),
        )
        role = Role(
            role.name,
            (
                Stage(
                    "idfs",
                    fit=True,
                    fixture=(["a", "b"],),
                    produces=lambda v: isinstance(v, dict),
                ),
            ),
            branches=role.branches,
        )
        seen = {}

        def verify(chains):
            seen.update({name: [s.label for s in steps] for name, steps in chains.items()})
            return True

        binding, refusal = resolve_chain(role, [module], (["a"],), verify=verify)

        self.assertIsNone(refusal)
        self.assertEqual(
            seen, {"text": ["theirs.embed_text"], "image": ["theirs.embed_image"]}
        )
        self.assertEqual(sorted(binding.branches), ["image", "text"])

    def test_a_branch_that_does_not_resolve_names_itself_in_the_refusal(self):
        module = _written("theirs", "def embed_text(texts):\n    return [1]\n")
        role = Role(
            "search",
            (),
            branches=(
                Role(
                    "text",
                    (Stage("text", produces=lambda v: isinstance(v, list)),),
                    fixture=(["a"],),
                ),
                Role(
                    "image",
                    (Stage("image", produces=lambda v: isinstance(v, dict)),),
                    fixture=([1],),
                ),
            ),
        )

        binding, refusal = resolve_chain(role, [module], (["a"],))

        self.assertIsNone(binding)
        self.assertEqual(refusal.role, "search.image")

    def test_a_role_without_branches_is_untouched(self):
        module = _module("anything", alpha=_spectrogram, beta=_peaks, gamma=_fanout)
        binding, _refusal = resolve_chain(ROLE, [module], FIXTURE)
        self.assertEqual(binding.branches, {})


class OnePartOfEachItemsResult(unittest.TestCase):
    """P5. Week 2's Bagel returns `(boxes, probabilities, descriptors)` per
    photo, and only element 2 is what the next step takes. `_mapped` gathered
    the whole tuples and the stage's validator refused the list."""

    def test_element_k_of_every_item_is_offered(self):
        module = _written(
            "theirs",
            "def describe(one):\n    return ('box', 0.9, [float(one)])\n",
        )
        vectors = lambda v: (
            isinstance(v, list) and bool(v) and isinstance(v[0], list)
        )
        stage = Stage("d", produces=vectors, per_item=True)

        found = probe_sources(stage, callables_in([module]), ([1, 2, 3],))

        self.assertEqual([c.label for c, _ in found], ["theirs.describe"])
        candidate, value = found[0]
        self.assertEqual(candidate.element, 2)
        self.assertEqual(value, [[1.0], [2.0], [3.0]])

    def test_the_element_and_the_loop_are_replayed_by_the_bound_step(self):
        module = _written(
            "theirs", "def describe(one):\n    return ('box', [float(one)])\n"
        )
        stage = Stage(
            "d",
            produces=lambda v: isinstance(v, list) and isinstance(v[0], list),
            per_item=True,
        )

        (candidate, _value), = probe_sources(stage, callables_in([module]), ([1],))

        self.assertTrue(candidate.per_item)
        self.assertEqual(candidate.bound([7, 8]), [[7.0], [8.0]])

    def test_a_whole_tuple_that_already_passes_keeps_no_element(self):
        module = _written("theirs", "def describe(one):\n    return (one, one)\n")
        stage = Stage("d", produces=lambda v: isinstance(v, list), per_item=True)

        (candidate, _value), = probe_sources(stage, callables_in([module]), ([1],))

        self.assertIsNone(candidate.element)


class TheItemsOwnName(unittest.TestCase):
    """P6. Week 2's Bagel writes `Whispers(vectors, names, threshold)`, where
    `names` is one label per descriptor. The benchmark knows which photo each
    descriptor came from, because it is the input it just passed."""

    def test_a_required_name_argument_is_offered_the_items_identities(self):
        module = _written(
            "theirs",
            "def build(vectors, names, threshold):\n"
            "    return [(n, threshold) for n in names]\n",
        )
        stage = Stage(
            "graph",
            produces=lambda v: isinstance(v, list),
            tunings=(0.35,),
            identity=True,
        )

        found = probe_sources(
            stage,
            callables_in([module]),
            ([[1.0], [2.0]],),
            identities=("a.png", "b.png"),
        )

        self.assertEqual([c.label for c, _ in found], ["theirs.build"])
        candidate, value = found[0]
        self.assertEqual(value, [("a.png", 0.35), ("b.png", 0.35)])
        self.assertEqual(candidate.plan, ("value", "identity", "tuning"))

    def test_identities_are_read_off_a_path_fixture_when_none_are_given(self):
        module = _written(
            "theirs", "def build(vectors, names):\n    return list(names)\n"
        )
        stage = Stage("g", produces=lambda v: isinstance(v, list), identity=True)

        found = probe_sources(
            stage, callables_in([module]), ([Path("a.png"), Path("b.png")],)
        )

        self.assertEqual(found[0][1], ["a.png", "b.png"])

    def test_a_per_item_stage_gives_each_item_its_own_name(self):
        # `name.upper()` is what makes this a per-photo function: handed the
        # whole list of names it raises, exactly as their own code does when
        # it splits a filename.
        module = _written(
            "theirs", "def describe(row, name):\n    return [name.upper()]\n"
        )
        stage = Stage(
            "d",
            produces=lambda v: isinstance(v, list) and isinstance(v[0], list),
            per_item=True,
            identity=True,
        )

        found = probe_sources(
            stage, callables_in([module]), ([[1.0], [2.0]],), identities=("a", "b")
        )

        self.assertEqual(found[0][1], [["A"], ["B"]])

    def test_a_stage_that_did_not_ask_is_never_given_a_name(self):
        module = _written(
            "theirs", "def build(vectors, names):\n    return list(names)\n"
        )
        stage = Stage("g", produces=lambda v: isinstance(v, list))

        self.assertEqual(
            probe_sources(
                stage, callables_in([module]), ([[1.0]],), identities=("a",)
            ),
            [],
        )


class TheirPipelineOverAFolder(unittest.TestCase):
    """P8. Some teams wrote a constructor that takes nothing and reads a
    directory. That is a different interface to the same work, and the honest
    answer is to give them a folder of the benchmark's own photos."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.files = []
        for name in ("one.png", "two.png"):
            path = self.tmp / name
            path.write_bytes(b"pretend photo")
            self.files.append(path)

    def _module(self):
        return _written(
            "theirs",
            "import os\n"
            "def build():\n"
            "    return sorted(os.listdir('baseImages'))\n",
        )

    def test_a_zero_argument_reader_is_handed_the_benchmarks_files(self):
        role = Role(
            "cluster",
            (
                Stage(
                    "d",
                    produces=lambda v: isinstance(v, list) and len(v) == 2,
                    folder=True,
                ),
            ),
        )

        binding, refusal = resolve_chain(role, [self._module()], (self.files,))

        self.assertIsNone(refusal)
        self.assertEqual([s.label for s in binding.steps], ["theirs.build"])
        self.assertEqual(binding.steps[0].supplied["folder"], "baseImages")

    def test_a_stage_that_did_not_ask_never_calls_a_zero_argument_function(self):
        role = Role("cluster", (Stage("d", produces=lambda v: isinstance(v, list)),))

        binding, refusal = resolve_chain(role, [self._module()], (self.files,))

        self.assertIsNone(binding)
        self.assertEqual(refusal.stage, "d")

    def test_a_reader_that_found_its_own_photos_is_not_a_binding(self):
        """Measured on one 2026 repository: `clusterCreator()` resolves its
        `baseImages` folder from `Path(__file__)` and describes the 34 photos
        of its own team. It succeeds, and what it returns is an answer about
        their data rather than about the benchmark's input."""

        theirs = self.tmp / "theirOwnPhotos"
        theirs.mkdir()
        (theirs / "aiken.png").write_bytes(b"their photo")
        module = _written(
            "theirs",
            "import os\n"
            "def build():\n"
            "    return sorted(os.listdir({!r}))\n".format(str(theirs)),
        )
        role = Role(
            "cluster",
            (Stage("d", produces=lambda v: isinstance(v, list), folder=True),),
        )

        binding, refusal = resolve_chain(role, [module], (self.files,))

        self.assertIsNone(binding)
        self.assertEqual(refusal.stage, "d")

    def test_nothing_is_written_where_the_benchmark_was_run_from(self):
        """The photos go into the throwaway directory the search probes from
        and nowhere else. Writing this test the direct way put a `baseImages`
        folder of PNGs into a checkout of this repository."""

        role = Role(
            "cluster",
            (Stage("d", produces=lambda v: isinstance(v, list), folder=True),),
        )
        here = Path.cwd()
        before = set(here.iterdir())

        resolve_chain(role, [self._module()], (self.files,))

        self.assertEqual(set(here.iterdir()), before)
        self.assertEqual(set(self.tmp.iterdir()), set(self.files))


class NamesNeverDecideWhetherARepositoryResolves(unittest.TestCase):
    """A preference may change the order chains are tried, never the outcome.

    Verification ran over `frontier[:beam]` only, so with more candidates that
    reach the end than the beam is wide, whether a repository resolved
    depended on where its working function sorted -- and `Stage.prefers` is
    what does the sorting.
    """

    @staticmethod
    def _modules():
        # Six one-stage candidates that all run and all return a plausible
        # string. Only `zz_good` returns the answer the week accepts, and it
        # sorts last, so at beam 4 it never reached the verifier.
        def _make(answer):
            def call(value, *, salt):
                return "{}-{}".format(answer, salt)

            return call

        members = {
            "aaa_one": _make("no"),
            "bbb_two": _make("no"),
            "ccc_three": _make("no"),
            "ddd_four": _make("no"),
            "eee_five": _make("no"),
            "zz_good": _make("yes"),
        }
        return [_module("decoys", **members)]

    @staticmethod
    def _role(prefers):
        return Role(
            "answer",
            (
                Stage(
                    "say",
                    prefers=prefers,
                    produces=lambda v: isinstance(v, str),
                    extras=("salt",),
                ),
            ),
        )

    @staticmethod
    def _accepts(chain):
        return chain[0].bound("anything").startswith("yes-")

    def _resolve(self, prefers):
        return resolve_chain(
            self._role(prefers),
            self._modules(),
            ("anything",),
            verify=self._accepts,
            extras={"salt": "s"},
        )

    def test_it_resolves_when_the_name_is_preferred(self):
        binding, refusal = self._resolve(("good",))

        self.assertIsNone(refusal)
        self.assertEqual(binding.steps[0].label, "decoys.zz_good")

    def test_it_resolves_just_the_same_with_every_preference_emptied(self):
        binding, refusal = self._resolve(())

        self.assertIsNone(refusal, refusal.detail if refusal else "")
        self.assertEqual(binding.steps[0].label, "decoys.zz_good")


class AFolderStageWantsSomethingThatReadsAFolder(unittest.TestCase):
    """`folder=True` starts calling zero-argument candidates, which the search
    does not otherwise do. A zero-argument call that succeeds without going
    near a folder is not the shape this exists for: binding it widens the
    candidate set to every no-argument callable in the repository, and it
    records no folder because none was supplied."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.files = []
        for index in range(3):
            item = self.tmp / "photo{}.txt".format(index)
            item.write_text("photo {}".format(index), encoding="utf-8")
            self.files.append(item)

    @staticmethod
    def _module():
        def aaa_factory():
            # Reads nothing. Sorts first. Returns a list, so `produces` passes.
            return []

        def zzz_reader():
            from pathlib import Path as _P

            return [
                p.read_text(encoding="utf-8") for p in sorted(_P("photos").iterdir())
            ]

        return _module("folders", aaa_factory=aaa_factory, zzz_reader=zzz_reader)

    def _role(self):
        return Role(
            "read",
            (Stage("d", produces=lambda v: isinstance(v, list), folder=True),),
        )

    def test_a_zero_argument_decoy_that_reads_nothing_is_not_a_folder_pipeline(self):
        binding, _refusal = resolve_chain(self._role(), [self._module()], (self.files,))

        self.assertIsNotNone(binding, "the real folder reader should still bind")
        self.assertEqual(binding.steps[0].label, "folders.zzz_reader")

    def test_the_folder_it_was_handed_is_recorded(self):
        binding, _refusal = resolve_chain(self._role(), [self._module()], (self.files,))

        self.assertEqual(binding.steps[0].supplied.get("folder"), "photos")


class AnOrdinaryParameterIsNotAnIdentitySlot(unittest.TestCase):
    """`id` occurs inside `width`, `grid` and `valid`. The identity check was
    `word in parameter.name.lower()`, so a function asking for a number was
    handed the list of photo identities and bound."""

    def test_width_is_not_asking_for_the_photo_identities(self):
        from cogbench.pipeline import _asks_for_identity

        for ordinary in ("width", "grid", "grid_size", "valid", "n_valid"):
            self.assertFalse(_asks_for_identity(ordinary), ordinary)

    def test_the_names_that_really_do_ask_still_do(self):
        from cogbench.pipeline import _asks_for_identity

        for asking in (
            "name",
            "names",
            "song_id",
            "image_ids",
            "filename",
            "filepath",
            "imagePath",
            "label",
            "titles",
            "identity",
        ):
            self.assertTrue(_asks_for_identity(asking), asking)

    def test_a_function_that_wanted_a_width_is_not_given_identities(self):
        def build(vectors, width):
            # A decoy: it runs on anything and returns a list either way, so
            # only the argument plan can tell the two readings apart.
            return [width for _ in vectors]

        role = Role(
            "graph",
            (Stage("g", produces=lambda v: isinstance(v, list), identity=True),),
        )

        binding, refusal = resolve_chain(
            role,
            [_module("shapes", build=build)],
            ([1, 2, 3],),
            identities=("a.png", "b.png", "c.png"),
        )

        if binding is not None:
            self.assertNotIn("identity", binding.steps[0].plan)
        else:
            self.assertEqual(refusal.stage, "g")


class AConstructorsMethodsFollowTheObjectTheChainCarries(unittest.TestCase):
    """A method reached through a constructor stage is stored bound to the
    object the SEARCH built, out of the search's fixture. A scored run builds
    that object again from the real input, and a step that kept calling the
    first one reported fixture state as the student's answer."""

    @staticmethod
    def _module():
        class Good:
            def __init__(self, rows):
                self.rows = list(rows)

            def read(self):
                return list(self.rows)

        return _module("store", Good=Good)

    def _binding(self):
        role = Role(
            "keep",
            (
                Stage("build", produces=lambda v: v is not None),
                Stage("read", produces=lambda v: isinstance(v, list)),
            ),
        )
        binding, refusal = resolve_chain(role, [self._module()], ([1],))
        self.assertIsNone(refusal, refusal.detail if refusal else "")
        self.assertEqual(len(binding.steps), 2)
        return binding

    def test_the_second_step_answers_about_the_object_it_was_given(self):
        build, read = self._binding().steps

        # Replayed the way a scored run replays it: the constructor runs
        # again on the real input, and the next step is called with what it
        # returned.
        rebuilt = build.bound([9])

        self.assertEqual(read.bound(rebuilt), [9])

    def test_the_search_itself_is_unchanged(self):
        build, read = self._binding().steps

        self.assertEqual(read.bound(build.bound([1])), [1])


class ABranchCanUseWhatAnEarlierBranchBuilt(unittest.TestCase):
    """Week 3 is four surfaces sharing one object: the prepare branch builds
    the store and the search branch calls a method on it. `_resolve_branches`
    made a `carried` list and passed it into every branch, and never put
    anything in it, so the shared instance pool it documents was empty every
    time and the second branch refused."""

    @staticmethod
    def _module():
        class Shared:
            def __init__(self, rows):
                self.rows = list(rows)

            def search(self, needle):
                return [row for row in self.rows if row == needle]

        return _module("shared", Shared=Shared)

    def test_the_search_branch_reaches_the_prepare_branchs_object(self):
        prepare = Role(
            "prepare",
            (Stage("store", produces=lambda v: v is not None),),
            fixture=([1, 2, 3],),
        )
        search = Role(
            "search",
            (Stage("ask", produces=lambda v: isinstance(v, list)),),
            fixture=(2,),
        )
        role = Role("all", (), branches=(prepare, search))

        binding, refusal = resolve_chain(role, [self._module()], ())

        self.assertIsNone(refusal, refusal.detail if refusal else "")
        self.assertEqual(
            [step.label for step in binding.branches["search"]],
            ["shared.Shared.search"],
        )
