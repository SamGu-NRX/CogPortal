from __future__ import annotations

import shutil
import signal
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

        module = _written("theirs", "def load(paths):\n    return [len(p.encode()) for p in paths]\n")
        stage = Stage("d", produces=lambda v: isinstance(v, list))
        fixture = Fixtures((([[1, 2]],), (["a.png", "b.png"],)))

        found = probe_sources(stage, callables_in([module]), fixture)

        self.assertEqual([c.label for c, _ in found], ["theirs.load"])
        self.assertEqual(found[0][0].form, 1)

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


def _imported(name, path):
    """A module from a real file, for code that resolves its own `__file__`.

    `_written` is enough for almost everything here, but a module built from
    a string has no file, and a team who computes a path from `__file__` is
    exactly the case some of these tests are about.
    """

    import importlib.util

    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
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

    def test_fusible_in_place_skips_do_not_cut_a_multi_step_mutation(self):
        source = "".join(
            "class Graph{0}:\n"
            "    def __init__(self, rows):\n        self.rows = list(rows)\n"
            "    def create_matrix(self):\n        pass\n"
            "    def create_nodes(self):\n        pass\n"
            "    def train_sweeps(self):\n        pass\n"
            "    def sorted_images(self):\n        return [0 for _ in self.rows]\n".format(
                index
            )
            for index in range(4)
        )
        module = _written("theirs", source)
        graph = lambda value: hasattr(value, "rows")
        labels = lambda value: isinstance(value, list) and len(value) == 2
        role = Role(
            "cluster",
            (
                Stage("graph", produces=graph),
                Stage(
                    "edges",
                    prefers=("matrix",),
                    produces=graph,
                    fusible=True,
                    in_place=True,
                ),
                Stage(
                    "nodes",
                    prefers=("nodes",),
                    produces=graph,
                    fusible=True,
                    in_place=True,
                ),
                Stage(
                    "settle",
                    prefers=("train",),
                    produces=labels,
                    in_place=True,
                ),
                Stage("labels", prefers=("sorted",), produces=labels),
            ),
        )
        expected = ["create_matrix", "create_nodes", "train_sweeps", "sorted_images"]

        def verify(steps):
            return [step.label.rsplit(".", 1)[-1] for step in steps[1:]] == expected

        binding, refusal = resolve_chain(
            role, [module], ([1, 2],), beam=4, verify=verify
        )

        self.assertIsNone(refusal)
        self.assertEqual(
            [step.label.rsplit(".", 1)[-1] for step in binding.steps[1:]], expected
        )

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

    def test_the_refusal_says_which_folder_of_theirs_was_in_the_way(self):
        """Refusing the constructor is right and, on its own, unreadable.

        A repository whose whole pipeline hangs off such a constructor has
        nothing else to offer, so the search wanders through whatever other
        classes it has and stalls several stages later. The refusal then names
        a hand-off that is true and beside the point. Measured on week 2's
        CoggurtFilter, which was told that nothing took what its profile class
        returned, a class its team never meant to be part of the pipeline.
        """

        checkout = self.tmp / "checkout"
        (checkout / "src").mkdir(parents=True)
        photos = checkout / "photos"
        photos.mkdir()
        (photos / "aiken.png").write_bytes(b"their photo")
        (checkout / "src" / "clustering.py").write_text(
            "import os\n"
            "from pathlib import Path\n"
            "class Album:\n"
            "    def __init__(self):\n"
            "        here = Path(__file__).resolve().parent.parent / 'photos'\n"
            "        self.names = sorted(os.listdir(here))\n"
        )
        module = _imported("clustering", checkout / "src" / "clustering.py")
        self.addCleanup(sys.modules.pop, "clustering", None)
        role = Role(
            "cluster",
            (Stage("d", produces=lambda v: isinstance(v, list), folder=True),),
        )

        binding, refusal = resolve_chain(role, [module], (self.files,))

        self.assertIsNone(binding)
        self.assertEqual(
            refusal.notes,
            (
                "clustering.Album() reads photos/ next to its own file, which "
                "holds your photos rather than the benchmark's, so it cannot "
                "be given the benchmark's photos; a constructor that takes "
                "the folder path as an argument, or reads it relative to the "
                "working directory, can.",
            ),
        )

    def test_a_repository_with_no_such_constructor_gets_no_such_note(self):
        role = Role("cluster", (Stage("d", produces=lambda v: v is None),))

        _binding, refusal = resolve_chain(role, [self._module()], (self.files,))

        self.assertEqual(refusal.notes, ())

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


class ABranchsOutputIsSomethingTheNextBranchCanTake(unittest.TestCase):
    """G1. Bagel's week 3 `CaptionImageQuery(EMBEDDINGS, ids)` takes the image
    branch's projected matrix, and Lashika's search takes the store the
    prepare branch built. The value a branch produced was thrown away the
    moment the branch was accepted, so neither could be reached and the
    prepare stage reported that nothing accepted the descriptors."""

    @staticmethod
    def _module():
        return _written(
            "theirs",
            "def project(rows):\n    return [r * 10 for r in rows]\n"
            "def index(ids, image):\n"
            "    return {i: v for i, v in zip(ids, image)}\n",
        )

    @staticmethod
    def _role():
        return Role(
            "all",
            (),
            branches=(
                Role(
                    "image",
                    (Stage("image", produces=lambda v: isinstance(v, list)),),
                    fixture=([1, 2],),
                ),
                Role(
                    "prepare",
                    (
                        Stage(
                            "prepare",
                            produces=lambda v: isinstance(v, dict),
                            extras=("image",),
                        ),
                    ),
                    fixture=(["a", "b"],),
                ),
            ),
        )

    def test_a_later_branch_is_handed_what_an_earlier_branch_produced(self):
        binding, refusal = resolve_chain(self._role(), [self._module()], ())

        self.assertIsNone(refusal, refusal.detail if refusal else "")
        self.assertEqual(
            [step.label for step in binding.branches["prepare"]], ["theirs.index"]
        )

    def test_the_step_records_the_branch_output_it_was_given(self):
        binding, _refusal = resolve_chain(self._role(), [self._module()], ())

        self.assertEqual(
            binding.branches["prepare"][0].plan, ("value", "extra:image")
        )


class ABranchsInputIsMadeWhenTheBranchRuns(unittest.TestCase):
    """G2. Week 3's search branch is probed with the text branch's own chain
    applied to the query string, and its prepare branch with the image
    branch's projected matrix alongside the raw descriptors. A fixture fixed
    at role construction cannot say either, because neither value exists
    until another branch has run."""

    @staticmethod
    def _module():
        return _written(
            "theirs",
            "def embed(texts):\n    return [len(t) for t in texts]\n"
            "def find(vector, k):\n    return [vector] * k\n",
        )

    def test_a_branch_is_probed_with_what_another_branch_produced(self):
        role = Role(
            "all",
            (),
            branches=(
                Role(
                    "text",
                    (
                        Stage(
                            "text",
                            produces=lambda v: isinstance(v, list)
                            and bool(v)
                            and isinstance(v[0], int),
                        ),
                    ),
                    fixture=(["abc"],),
                ),
                Role(
                    "search",
                    (Stage("search", produces=lambda v: isinstance(v, list)),),
                    fixture=lambda pool, chains: (pool["text"][0], 2),
                ),
            ),
        )

        binding, refusal = resolve_chain(role, [self._module()], ())

        self.assertIsNone(refusal, refusal.detail if refusal else "")
        self.assertEqual(
            [step.label for step in binding.branches["search"]], ["theirs.find"]
        )

    def test_the_fixture_is_also_shown_the_chains_that_bound(self):
        seen = {}

        def made(pool, chains):
            seen.update(chains)
            return (3, 2)

        role = Role(
            "all",
            (),
            branches=(
                Role(
                    "text",
                    (Stage("text", produces=lambda v: isinstance(v, list)),),
                    fixture=(["abc"],),
                ),
                Role(
                    "search",
                    (Stage("search", produces=lambda v: isinstance(v, list)),),
                    fixture=made,
                ),
            ),
        )

        resolve_chain(role, [self._module()], ())

        self.assertEqual(
            {name: [step.label for step in steps] for name, steps in seen.items()},
            {"text": ["theirs.embed"]},
        )


class BranchesResolveUntilNothingMoreCan(unittest.TestCase):
    """G3. Lashika's week 3 image step is a method of the object the PREPARE
    branch constructs, `ImageDatabase(ids, descriptors, W)
    .descriptor_to_embedding`, so image has to come after prepare. Bagel's
    prepare takes the IMAGE branch's projected matrix, so prepare has to come
    after image. One declared order cannot serve both repositories."""

    @staticmethod
    def _module():
        class ImageDatabase:
            def __init__(self, ids, descriptors):
                self.ids = list(ids)
                self.descriptors = list(descriptors)

            def descriptor_to_embedding(self, descriptor):
                return [descriptor * 2]

        return _module("theirs", ImageDatabase=ImageDatabase)

    @staticmethod
    def _role():
        rows = lambda v: isinstance(v, list) and bool(v) and isinstance(v[0], list)
        return Role(
            "all",
            (),
            branches=(
                # Declared first and only bindable last.
                Role(
                    "image",
                    (Stage("image", produces=rows, per_item=True),),
                    fixture=([1, 2],),
                ),
                Role(
                    "prepare",
                    (Stage("prepare", produces=lambda v: hasattr(v, "ids")),),
                    fixture=([10, 20], [1, 2]),
                ),
            ),
        )

    def test_a_branch_declared_first_may_bind_after_one_declared_later(self):
        binding, refusal = resolve_chain(self._role(), [self._module()], ())

        self.assertIsNone(refusal, refusal.detail if refusal else "")
        self.assertEqual(
            [step.label for step in binding.branches["image"]],
            ["theirs.ImageDatabase.descriptor_to_embedding"],
        )

    def test_the_fixpoint_is_the_same_every_time(self):
        """Labels, because a method of a constructor stage is bound to the
        object that stage just built and two searches build two objects.
        What is written down is the name, which is what has to agree."""

        first, _ = resolve_chain(self._role(), [self._module()], ())
        second, _ = resolve_chain(self._role(), [self._module()], ())

        def named(binding):
            return {
                name: [step.label for step in steps]
                for name, steps in binding.branches.items()
            }

        self.assertEqual(named(first), named(second))
        self.assertEqual(list(first.branches), list(second.branches))

    def test_a_fixture_that_cannot_be_made_yet_is_tried_again_next_pass(self):
        module = _written(
            "later",
            "def embed(texts):\n    return [len(t) for t in texts]\n"
            "def find(vector, k):\n    return [vector] * k\n",
        )
        role = Role(
            "all",
            (),
            branches=(
                # Its fixture raises KeyError on the first pass, because the
                # branch that fills that slot is declared after it.
                Role(
                    "search",
                    (Stage("search", produces=lambda v: isinstance(v, list)),),
                    fixture=lambda pool, chains: (pool["text"][0], 2),
                ),
                Role(
                    "text",
                    (
                        Stage(
                            "text",
                            produces=lambda v: isinstance(v, list)
                            and bool(v)
                            and isinstance(v[0], int),
                        ),
                    ),
                    fixture=(["abc"],),
                ),
            ),
        )

        binding, refusal = resolve_chain(role, [module], ())

        self.assertIsNone(refusal, refusal.detail if refusal else "")
        self.assertEqual(sorted(binding.branches), ["search", "text"])


class ASideInputThatIsItselfAStep(unittest.TestCase):
    """G4. Bagel's week 3 image encoder is `ImageToCaption()`, built with no
    arguments, handed their own pickle through `.load(path)`, and then
    called. `methods_of` skips `__call__` with every other underscore name
    and the loaded instance lives in the extras pool rather than in one of
    their modules, so nothing in the repository could serve that stage."""

    def test_a_callable_pool_entry_is_offered_for_a_stage_that_named_it(self):
        module = _written("theirs", "def unrelated(x):\n    return None\n")
        stage = Stage(
            "image",
            produces=lambda v: isinstance(v, list),
            extras=("weights_model",),
        )

        found = probe_sources(
            stage,
            callables_in([module]),
            ([1, 2],),
            extras={"weights_model": _Encoder()},
        )

        self.assertEqual([c.label for c, _ in found], ["weights_model (_Encoder)"])
        self.assertEqual(found[0][1], [3, 6])

    def test_one_of_their_own_functions_is_tried_first(self):
        module = _written(
            "theirs", "def encode(rows):\n    return [r + 1 for r in rows]\n"
        )
        stage = Stage(
            "image",
            produces=lambda v: isinstance(v, list),
            extras=("weights_model",),
        )

        found = probe_sources(
            stage,
            callables_in([module]),
            ([1, 2],),
            extras={"weights_model": _Encoder()},
        )

        self.assertEqual([c.label for c, _ in found][0], "theirs.encode")

    def test_the_object_it_was_handed_is_recorded_on_the_step(self):
        module = _written("theirs", "def unrelated(x):\n    return None\n")
        stage = Stage(
            "image",
            produces=lambda v: isinstance(v, list),
            extras=("weights_model",),
        )

        (candidate, _value), = probe_sources(
            stage,
            callables_in([module]),
            ([1],),
            extras={"weights_model": _Encoder()},
        )

        self.assertEqual(candidate.supplied["pooled"], "weights_model")

    def test_a_pool_entry_that_is_only_data_is_never_a_step(self):
        module = _written("theirs", "def unrelated(x):\n    return None\n")
        stage = Stage(
            "text", produces=lambda v: isinstance(v, list), extras=("glove",)
        )

        found = probe_sources(
            stage, callables_in([module]), ([1],), extras={"glove": {"a": 1}}
        )

        self.assertEqual(found, [])


class _Encoder:
    """One of their objects, built and loaded by the benchmark."""

    def __call__(self, rows):
        return [row * 3 for row in rows]


class WhichPartOfATupleBoundIsPartOfTheBinding(unittest.TestCase):
    """G5. rutvim's week 1 `spectrogram_conversion` returns
    `(log_spectrogram, peaks)` and their `generate_fingerprints` accepts
    either: 609 fingerprints and 0.547 on the peaks, 2970 and 0.094 on the
    spectrogram. The search knows which one bound at the moment it binds; a
    run that re-derived it later scored the other one and reported the
    difference as their code."""

    @staticmethod
    def _role():
        return Role(
            "fingerprint",
            (
                Stage("fused", produces=lambda v: isinstance(v, tuple)),
                Stage(
                    "fingerprints",
                    produces=lambda v: isinstance(v, list)
                    and bool(v)
                    and isinstance(v[0], tuple),
                ),
            ),
        )

    def test_the_part_that_bound_is_recorded_and_replayed(self):
        module = _written(
            "theirs",
            "def fused(samples):\n    return ('grid', [(0, 1), (2, 3)])\n"
            "def prints(peaks):\n    return [((a, b), 0) for a, b in peaks]\n",
        )

        binding, refusal = resolve_chain(self._role(), [module], ([1],))

        self.assertIsNone(refusal, refusal.detail if refusal else "")
        self.assertEqual(binding.steps[1].handoff, "element:1")
        self.assertEqual(
            binding.steps[1].bound(("grid", [(4, 5)])), [((4, 5), 0)]
        )

    def test_a_pair_passed_as_two_arguments_is_recorded_as_spread(self):
        module = _written(
            "theirs",
            "def build(items):\n    return ([1, 2], {'w': 5})\n"
            "def settle(nodes, adj):\n"
            "    return [(n, adj['w']) for n in nodes]\n",
        )
        role = Role(
            "group",
            (
                Stage("build", produces=lambda v: isinstance(v, tuple)),
                Stage(
                    "settle",
                    produces=lambda v: isinstance(v, list)
                    and bool(v)
                    and isinstance(v[0], tuple),
                ),
            ),
        )

        binding, refusal = resolve_chain(role, [module], ([1],))

        self.assertIsNone(refusal, refusal.detail if refusal else "")
        self.assertEqual(binding.steps[1].handoff, "spread")
        self.assertEqual(binding.steps[1].bound(([9], {"w": 5})), [(9, 5)])

    def test_a_pair_taken_the_other_way_round_is_recorded_as_reversed(self):
        module = _written(
            "theirs",
            "def build(items):\n    return ([1, 2], {'w': 5})\n"
            "def settle(adj, nodes):\n"
            "    return [(n, adj['w']) for n in nodes]\n",
        )
        role = Role(
            "group",
            (
                Stage("build", produces=lambda v: isinstance(v, tuple)),
                Stage(
                    "settle",
                    produces=lambda v: isinstance(v, list)
                    and bool(v)
                    and isinstance(v[0], tuple),
                ),
            ),
        )

        binding, refusal = resolve_chain(role, [module], ([1],))

        self.assertIsNone(refusal, refusal.detail if refusal else "")
        self.assertEqual(binding.steps[1].handoff, "reversed")
        self.assertEqual(binding.steps[1].bound(([9], {"w": 5})), [(9, 5)])

    def test_a_step_handed_the_whole_value_records_nothing(self):
        module = _module("anything", alpha=_spectrogram, beta=_peaks, gamma=_fanout)

        binding, _refusal = resolve_chain(ROLE, [module], FIXTURE)

        self.assertEqual([step.handoff for step in binding.steps], [None, None, None])


class ABranchTheWeekMayDoWithout(unittest.TestCase):
    """G6. A week 3 repository with no trained weights has no image side at
    all, and the decided policy withholds those numbers rather than zeroing
    them (docs/design/discovery-v2-brief.md, "Absent weights"). That only
    means anything if the text branch still binds: refusing the whole role
    tells a team whose caption embedding works that their code is not wired
    up."""

    @staticmethod
    def _module():
        return _written(
            "theirs", "def embed(texts):\n    return [len(t) for t in texts]\n"
        )

    @staticmethod
    def _role(optional):
        return Role(
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
                    optional=optional,
                ),
            ),
        )

    def test_the_role_binds_without_a_branch_the_week_can_do_without(self):
        binding, refusal = resolve_chain(self._role(True), [self._module()], ())

        self.assertIsNone(refusal, refusal.detail if refusal else "")
        self.assertEqual(sorted(binding.branches), ["text"])

    def test_the_branch_that_is_absent_is_named_with_the_refusal_it_ended_on(self):
        binding, _refusal = resolve_chain(self._role(True), [self._module()], ())

        self.assertEqual(sorted(binding.missing), ["image"])
        self.assertEqual(binding.missing["image"].stage, "image")

    def test_a_required_branch_that_never_binds_still_refuses_the_role(self):
        binding, refusal = resolve_chain(self._role(False), [self._module()], ())

        self.assertIsNone(binding)
        self.assertEqual(refusal.role, "search.image")

    def test_the_week_is_handed_only_the_branches_that_bound(self):
        seen = {}

        def verify(chains):
            seen.update(chains)
            return True

        resolve_chain(self._role(True), [self._module()], (), verify=verify)

        self.assertEqual(sorted(seen), ["text"])


class AHandoffThatCannotBeAppliedIsNotSilentlyAnotherOne(unittest.TestCase):
    """The search bound a step on one part of what came before it. A run
    whose upstream has no such part has changed shape, and the step must
    say so rather than quietly take the whole value, which is a call the
    search never proved."""

    def test_a_missing_element_raises_and_names_the_reading(self):
        from cogbench.pipeline import _handed

        step = Candidate("t.f", lambda v: v, "t", handoff="element:2")

        with self.assertRaises(TypeError) as caught:
            _handed(step, ((1, 2),))
        self.assertIn("element:2", str(caught.exception))
        self.assertIn("t.f", str(caught.exception))

    def test_a_present_element_is_read_as_before(self):
        from cogbench.pipeline import _handed

        step = Candidate("t.f", lambda v: v, "t", handoff="element:1")

        self.assertEqual(_handed(step, ((1, 2),)), (2,))


class AFixtureThatFailsIsNotAFixtureThatIsNotReady(unittest.TestCase):
    """A branch fixture that raises because the pool lacks what it reads is
    tried again next pass. One that raises for a reason of its own is the
    week's bug, and the refusal has to say which."""

    def test_a_missing_pool_key_reads_as_not_yet(self):
        branch = Role(
            "a", (Stage("a", produces=lambda v: True),),
            fixture=lambda pool, chains: (pool["never"],),
        )
        _binding, refusal = resolve_chain(
            Role("all", (), branches=(branch,)), [_module("t", f=lambda x: x)], ()
        )
        self.assertIn("not produced by any other branch", refusal.detail)

    def test_a_fixture_that_breaks_names_its_own_error(self):
        def broken(pool, chains):
            raise RuntimeError("their loader broke")

        branch = Role("a", (Stage("a", produces=lambda v: True),), fixture=broken)
        _binding, refusal = resolve_chain(
            Role("all", (), branches=(branch,)), [_module("t", f=lambda x: x)], ()
        )
        self.assertIn("RuntimeError", refusal.detail)
        self.assertIn("their loader broke", refusal.detail)


class AStepsSideInputsAreThisRunsNotTheSearchs(unittest.TestCase):
    """A step bound with another branch's output as its extra kept the
    search fixture's value on `supplied`, and a scored run built its
    database from that. `runtime_pool` puts the run's own values in front."""

    @staticmethod
    def _module():
        return _written(
            "theirs",
            "def project(rows):\n    return [r * 10 for r in rows]\n"
            "def index(ids, image):\n    return {i: v for i, v in zip(ids, image)}\n",
        )

    def _binding(self):
        role = Role(
            "all", (),
            branches=(
                Role("image", (Stage("image", produces=lambda v: isinstance(v, list)),), fixture=([1, 2],)),
                Role("prepare", (Stage("prepare", produces=lambda v: isinstance(v, dict), extras=("image",)),), fixture=(["a", "b"],)),
            ),
        )
        binding, refusal = resolve_chain(role, [self._module()], ())
        self.assertIsNone(refusal)
        return binding

    def test_without_a_runtime_pool_the_fixture_value_is_used(self):
        binding = self._binding()
        prepare = binding.branches["prepare"][0]
        self.assertEqual(prepare.bound(["a", "b"]), {"a": 10, "b": 20})

    def test_the_runtime_pool_replaces_it_for_the_scored_run(self):
        from cogbench.pipeline import runtime_pool

        binding = self._binding()
        image = binding.branches["image"][0]
        prepare = binding.branches["prepare"][0]
        run_rows = image.bound([7, 8])
        with runtime_pool({"image": run_rows}):
            self.assertEqual(prepare.bound(["a", "b"]), {"a": 70, "b": 80})
        self.assertEqual(prepare.bound(["a", "b"]), {"a": 10, "b": 20})


class AMethodCarriedAcrossBranchesIsTakenOffThisRunsObject(unittest.TestCase):
    @staticmethod
    def _module():
        return _written(
            "theirs",
            "class Store:\n"
            "    def __init__(self, rows):\n        self.rows = list(rows)\n"
            "    def search(self, needle):\n        return [r for r in self.rows if r == needle]\n",
        )

    def test_the_search_step_answers_about_the_scored_store(self):
        from cogbench.pipeline import runtime_pool

        prepare = Role("prepare", (Stage("store", produces=lambda v: v is not None),), fixture=([1, 2, 3],))
        search = Role("search", (Stage("ask", produces=lambda v: isinstance(v, list)),), fixture=(2,))
        binding, refusal = resolve_chain(Role("all", (), branches=(prepare, search)), [self._module()], ())
        self.assertIsNone(refusal)
        ask = binding.branches["search"][0]
        self.assertEqual(ask.branch, "prepare")
        self.assertEqual(ask.bound(2), [2])

        scored_store = binding.branches["prepare"][0].bound([9, 9])
        with runtime_pool({"prepare": scored_store}):
            self.assertEqual(ask.bound(9), [9, 9])
            self.assertEqual(ask.bound(2), [])


class SpreadAndReversedNeedATuple(unittest.TestCase):
    def test_a_list_is_not_spread(self):
        from cogbench.pipeline import _handed

        with self.assertRaises(TypeError):
            _handed(Candidate("t.f", lambda *a: a, "t", handoff="spread"), ([1, 2],))
        with self.assertRaises(TypeError):
            _handed(Candidate("t.f", lambda *a: a, "t", handoff="reversed"), ([1, 2],))
        with self.assertRaises(TypeError):
            _handed(Candidate("t.f", lambda *a: a, "t", handoff="element:0"), ([1, 2],))
        self.assertEqual(_handed(Candidate("t.f", lambda *a: a, "t", handoff="spread"), ((1, 2),)), (1, 2))


class AStudentCallThatReturnsAsTheClockRunsOutIsStillJustANo(unittest.TestCase):
    """The alarm used to be cancelled in the outer `finally`, outside the
    `except`, so a `_Timeout` raised between the student call returning and
    the cancel left `_call` and ended the whole search. One 2026 repository's
    constructor probe took exactly the ten seconds and did that."""

    @unittest.skipUnless(
        all(
            hasattr(signal, name)
            for name in ("SIGALRM", "ITIMER_REAL", "setitimer", "getitimer")
        ),
        "requires SIGALRM and POSIX interval timers",
    )
    def test_the_timeout_never_leaves_the_call(self):
        from cogbench import pipeline
        from cogbench.pipeline import Candidate, _call

        def slow(value):
            # Let the alarm fire while the frame is still inside the guarded
            # block: a zero-delay alarm is delivered at the next bytecode.
            signal.setitimer(signal.ITIMER_REAL, 0.001)
            end = time.monotonic() + 0.2
            while time.monotonic() < end:
                pass
            return value

        ok, value = _call(Candidate("theirs.slow", slow, "theirs"), (1,))

        self.assertFalse(ok)
        self.assertIsNone(value)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))

    def test_module_values_leave_out_functions_classes_and_modules(self):
        import types
        from cogbench.pipeline import values_in

        module = _module(
            "theirs",
            idf={"a": 0.5},
            helper=lambda: None,
            Thing=type("Thing", (), {}),
            np=types.ModuleType("np"),
            _private=[1],
            nothing=None,
        )

        self.assertEqual(
            [(label, value) for label, _, value in values_in([module])],
            [("theirs.idf", {"a": 0.5})],
        )


class AWholeCallThatAnswersWronglyDoesNotHideThePerItemForm(unittest.TestCase):
    """One 2026 tokenizer walks its argument character by character. Handed
    the whole list of captions it treated each caption as one character,
    returned a single flat token list, and because that call had "succeeded"
    the per-item form was never tried and the branch refused."""

    def _stage(self):
        return Stage(
            "tokens",
            produces=lambda v: isinstance(v, list) and bool(v) and isinstance(v[0], list),
            per_item=True,
        )

    def test_the_per_item_form_is_tried_and_kept(self):
        module = _written(
            "theirs",
            "def tokenize(text):\n    return [str(c) for c in text]\n",
        )

        (candidate, value), = probe_sources(
            self._stage(), callables_in([module]), (["ab", "cd"],)
        )

        self.assertTrue(candidate.per_item)
        self.assertEqual(value, [["a", "b"], ["c", "d"]])

    def test_a_whole_answer_of_the_right_shape_is_kept_as_it_was(self):
        module = _written(
            "theirs",
            "def tokenize(texts):\n    return [list(t) for t in texts]\n",
        )

        (candidate, value), = probe_sources(
            self._stage(), callables_in([module]), (["ab"],)
        )

        self.assertFalse(candidate.per_item)
        self.assertEqual(value, [["a", "b"]])


class AFusedFirstStepIsCarriedPastTheBeam(unittest.TestCase):
    """A chain whose first function already did the second stage's work is
    appended after every plain first-stage hit. At the last stage the whole
    frontier is read rather than the beam's share of it, so with four or
    more plain hits ahead of it the fused chain is still asked."""

    def test_the_fused_chain_survives_four_plain_hits(self):
        def plain(texts):
            return [list(t) for t in texts]

        def fused(texts):
            return [[1.0] for _ in texts]

        module = _module(
            "theirs",
            aaa=plain,
            bbb=plain,
            ccc=plain,
            ddd=plain,
            eee=plain,
            embed=fused,
        )
        role = Role(
            "text",
            (
                Stage(
                    "tokens",
                    produces=lambda v: isinstance(v, list) and isinstance(v[0][0], str),
                    fusible=True,
                ),
                Stage(
                    "text",
                    produces=lambda v: isinstance(v, list) and isinstance(v[0][0], float),
                ),
            ),
        )

        binding, refusal = resolve_chain(
            role,
            [module],
            (["ab"],),
            beam=4,
            # Only the fused chain is right; the point is that it is asked.
            verify=lambda steps: [s.label for s in steps] == ["theirs.embed"],
        )

        self.assertIsNone(refusal)
        self.assertEqual([s.label for s in binding.steps], ["theirs.embed"])


class AChainThroughTheirOwnFunctionIsAskedBeforeAFusedOne(unittest.TestCase):
    """rutvim's week 3 `embed_text(tokens, ...)` also accepts a raw caption and
    iterates its characters. Both `caption_processor -> embed_text` and
    `embed_text` alone pass the week's test; the first is how they wrote it."""

    def test_the_unfused_chain_wins_when_both_pass(self):
        def tokens(text):
            return text.split()

        def embed(words):
            # A str is iterable too, so this "accepts" a raw caption.
            return [float(len(w)) for w in words]

        module = _module("theirs", tokens=tokens, embed=embed)
        role = Role(
            "text",
            (
                Stage(
                    "tokens",
                    produces=lambda v: isinstance(v, list) and isinstance(v[0], list),
                    per_item=True,
                    fusible=True,
                ),
                Stage(
                    "text",
                    produces=lambda v: isinstance(v, list) and isinstance(v[0], list)
                    and isinstance(v[0][0], float),
                    per_item=True,
                ),
            ),
        )

        binding, refusal = resolve_chain(
            role, [module], (["a bb", "ccc d"],), verify=lambda steps: True
        )

        self.assertIsNone(refusal)
        self.assertEqual([s.label for s in binding.steps], ["theirs.tokens", "theirs.embed"])


class AFusibleStageCanBeAbsorbedByTheStepAfterIt(unittest.TestCase):
    """Cog-gurts' `fingerprint_recording(spectrogram)` finds the peaks and
    pairs them in one call, and their separate peak finder needs a
    neighbourhood array and an amplitude floor no benchmark can supply.
    Folding the peaks stage into the function BEFORE it cannot reach that,
    because a spectrogram is not peaks."""

    def _role(self, guard=None):
        return Role(
            "fingerprint",
            (
                Stage("spectrogram", produces=lambda v: isinstance(v, list) and v and isinstance(v[0], list)),
                Stage("peaks", produces=lambda v: isinstance(v, list) and v and isinstance(v[0], tuple), fusible=True),
                Stage(
                    "fingerprints",
                    produces=lambda v: isinstance(v, dict) and bool(v),
                    accepts=guard,
                ),
            ),
        )

    def test_the_following_step_takes_this_stages_input(self):
        module = _written(
            "theirs",
            "def spectrogram(samples, rate):\n    return [[1.0, 2.0], [3.0, 4.0]]\n"
            "def peak_locations(spec, neighbourhood, floor):\n    return [(0, 1)]\n"
            "def fingerprint_recording(spec):\n    return {(1, 2, 3): 0}\n",
        )

        binding, refusal = resolve_chain(self._role(), [module], ([0.0] * 10, 44100))

        self.assertIsNone(refusal)
        self.assertEqual(
            [s.label for s in binding.steps],
            ["theirs.spectrogram", "theirs.fingerprint_recording"],
        )
        self.assertEqual(binding.describe()[-1].split(" <- ")[0] if False else binding._stage_names[-1], "peaks + fingerprints")

    def test_the_following_stages_own_accepts_does_not_refuse_the_input(self):
        """The guard on the fingerprints stage says what it takes from the
        PEAKS stage's output; it must not refuse the peaks stage's input."""

        module = _written(
            "theirs",
            "def spectrogram(samples, rate):\n    return [[1.0, 2.0], [3.0, 4.0]]\n"
            "def fingerprint_recording(spec):\n    return {(1, 2, 3): 0}\n",
        )
        refuse_matrices = lambda v: not (isinstance(v, list) and isinstance(v[0], list))

        binding, refusal = resolve_chain(
            self._role(guard=refuse_matrices), [module], ([0.0] * 10, 44100)
        )

        self.assertIsNone(refusal)
        self.assertEqual(binding._stage_names[-1], "peaks + fingerprints")

    def test_a_chain_with_a_real_peak_step_is_asked_first(self):
        module = _written(
            "theirs",
            "def spectrogram(samples, rate):\n    return [[1.0, 2.0], [3.0, 4.0]]\n"
            "def peaks(spec):\n    return [(0, 1)]\n"
            "def fingerprints(peaks):\n    return {(1, 2, 3): 0}\n"
            "def fingerprint_recording(spec):\n    return {(9, 9, 9): 0}\n",
        )

        binding, refusal = resolve_chain(self._role(), [module], ([0.0] * 10, 44100))

        self.assertIsNone(refusal)
        # A separate peak step was found, so the forward reading (input of
        # the peaks stage handed to a fingerprinter) was not the one asked.
        # Which of the two fingerprinters follows `peaks` is the beam's
        # ordinary order and not what this test pins.
        self.assertEqual(binding._stage_names, ("spectrogram", "peaks", "fingerprints"))
        self.assertEqual(binding.steps[1].label, "theirs.peaks")


class AnInPlaceStepIsReplayedByTheBoundCall(unittest.TestCase):
    """The search records a step that returned nothing and changed its
    argument as `in_place` and carries the argument forward. `bound` handed
    the next step None instead, which an independent review found; no week
    had witnessed it because week 2 replays through its own `_run`."""

    def test_the_object_goes_forward_when_the_call_returns_nothing(self):
        from cogbench.pipeline import Candidate

        def settle(graph):
            graph.append("settled")

        step = Candidate("theirs.settle", settle, "theirs", in_place=True)
        graph = ["node"]

        self.assertIs(step.bound(graph), graph)
        self.assertEqual(graph, ["node", "settled"])

    def test_a_value_the_call_returns_is_still_returned(self):
        from cogbench.pipeline import Candidate

        step = Candidate("theirs.read", lambda graph: list(graph), "theirs", in_place=True)

        self.assertEqual(step.bound(["a"]), ["a"])


class ABranchBoundOnTheWrongFormIsRetriedWhenALaterBranchCannotBind(unittest.TestCase):
    """Bagel's `CaptionImageQuery(image_embeddings, image_ids)` builds with
    the ids and the descriptors in either order, and only its `search` can
    tell which was right. The prepare branch bound on the first form that
    constructed, and the search branch then found nothing to call."""

    def _module(self):
        return _written(
            "theirs",
            "class Store:\n"
            "    def __init__(self, rows, ids):\n"
            "        self.rows = list(rows)\n"
            "        self.ids = list(ids)\n"
            "    def search(self, k):\n"
            "        if not isinstance(self.rows[0], float):\n"
            "            raise TypeError('the rows are ids')\n"
            "        return self.ids[:k]\n",
        )

    def _role(self):
        prepare = Role(
            "prepare",
            (Stage("prepare", produces=lambda v: hasattr(v, "ids")),),
            fixture=Fixtures((([1, 2], [0.5, 0.25]), ([0.5, 0.25], [1, 2]))),
        )
        search = Role(
            "search",
            (
                Stage(
                    "search",
                    produces=lambda v: isinstance(v, list) and bool(v) and isinstance(v[0], int),
                ),
            ),
            fixture=(1,),
            optional=True,
        )
        return Role("all", (), branches=(prepare, search))

    def test_the_form_a_later_branch_can_use_wins(self):
        binding, refusal = resolve_chain(self._role(), [self._module()], ((),))

        self.assertIsNone(refusal)
        self.assertEqual(sorted(binding.branches), ["prepare", "search"])
        self.assertEqual(binding.branches["prepare"][0].form, 1)
        self.assertEqual(binding.missing, {})

    def test_a_repository_with_no_later_function_keeps_its_first_binding(self):
        module = _written(
            "theirs",
            "class Store:\n"
            "    def __init__(self, rows, ids):\n"
            "        self.rows = list(rows)\n        self.ids = list(ids)\n",
        )

        binding, refusal = resolve_chain(self._role(), [module], ((),))

        self.assertIsNone(refusal)
        self.assertEqual(sorted(binding.branches), ["prepare"])
        self.assertEqual(binding.branches["prepare"][0].form, 0)
        self.assertEqual(sorted(binding.missing), ["search"])


class AFunctionParkedInsideAClassIsACandidate(unittest.TestCase):
    """One 2026 team keeps its whole pipeline under `class Spectogram:` with
    no `self` anywhere and calls each piece unbound. `methods_of` exposed
    only the bound copy, where the first argument is swallowed as `self`."""

    def test_the_unbound_function_is_offered_and_a_real_method_is_not(self):
        module = _written(
            "theirs",
            "class Namespace:\n"
            "    def match(fp, database, index):\n"
            "        return index[max(database, key=database.get)]\n"
            "    def helper(self):\n"
            "        return 1\n"
            "    @staticmethod\n"
            "    def other(a):\n"
            "        return a\n",
        )

        labels = [c.label for c in callables_in([module])]

        self.assertIn("theirs.Namespace.match", labels)
        self.assertNotIn("theirs.Namespace.helper", labels)
        self.assertNotIn("theirs.Namespace.other", labels)
        match = next(c for c in callables_in([module]) if c.label.endswith("match"))
        self.assertEqual(match.call([1], {"a": 2, "b": 5}, {"b": "song"}), "song")


class FormBacktrackingSearchesEveryCombinationItNeeds(unittest.TestCase):
    """An independent review built a role where the only working pair of
    forms was (A=2, B=0) and the first search never tried it: a ban on B's
    form 0, placed under A=0, stayed in force after A moved."""

    def _module(self):
        return _written(
            "theirs",
            "class A:\n"
            "    def __init__(self, x):\n        self.x = x\n"
            "class B:\n"
            "    def __init__(self, y):\n        self.y = y\n"
            "def c(a, b):\n"
            "    if a.x == 'a2' and b.y == 'b0':\n        return ['ok']\n"
            "    raise TypeError('not this pair')\n",
        )

    def _role(self):
        a = Role("A", (Stage("A", produces=lambda v: hasattr(v, "x")),), fixture=Fixtures((("a0",), ("a1",), ("a2",))))
        b = Role("B", (Stage("B", produces=lambda v: hasattr(v, "y")),), fixture=Fixtures((("b0",), ("b1",))))
        c = Role(
            "C",
            (Stage("C", produces=lambda v: v == ["ok"], extras=("A", "B")),),
            fixture=lambda pool, chains: (pool["A"], pool["B"]) if "A" in pool and "B" in pool else None,
        )
        from dataclasses import replace as _replace

        return Role("all", (), branches=(a, b, _replace(c, optional=True)))

    def test_the_pair_a_later_branch_needs_is_found(self):
        binding, refusal = resolve_chain(self._role(), [self._module()], ((),))

        self.assertIsNone(refusal)
        self.assertEqual(sorted(binding.branches), ["A", "B", "C"])
        self.assertEqual(binding.branches["A"][0].form, 2)
        self.assertEqual(binding.branches["B"][0].form, 0)

    def test_an_attempt_covering_the_required_branch_beats_an_earlier_one(self):
        module = _written(
            "theirs",
            "class A:\n"
            "    def __init__(self, x):\n        self.x = x\n"
            "def opt(a):\n"
            "    if a.x == 'a0':\n        return 'optional'\n"
            "    raise TypeError\n"
            "def req(a):\n"
            "    if a.x == 'a1':\n        return 'required'\n"
            "    raise TypeError\n",
        )
        a = Role("A", (Stage("A", produces=lambda v: hasattr(v, "x")),), fixture=Fixtures((("a0",), ("a1",))))
        optional = Role("O", (Stage("O", produces=lambda v: v == "optional"),), fixture=lambda pool, chains: (pool["A"],), optional=True)
        required = Role("R", (Stage("R", produces=lambda v: v == "required"),), fixture=lambda pool, chains: (pool["A"],))
        role = Role("all", (), branches=(a, optional, required))

        binding, refusal = resolve_chain(role, [module], ((),))

        self.assertIsNone(refusal)
        self.assertIn("R", binding.branches)
        self.assertEqual(sorted(binding.missing), ["O"])


class InPlaceReplayCoversEveryCallPath(unittest.TestCase):
    def test_a_self_only_in_place_method_hands_on_its_object(self):
        from cogbench.pipeline import Candidate

        class Graph:
            def __init__(self):
                self.settled = False

            def settle(self):
                self.settled = True

        graph = Graph()
        step = Candidate(
            "theirs.Graph.settle", graph.settle, "theirs",
            self_only=True, in_place=True, attribute="settle", owner=Graph,
        )

        self.assertIs(step.bound(graph), graph)
        self.assertTrue(graph.settled)

    def test_a_per_item_in_place_step_hands_on_the_items(self):
        from cogbench.pipeline import Candidate

        def mark(item):
            item.append("seen")

        items = [[1], [2]]
        step = Candidate("theirs.mark", mark, "theirs", per_item=True, in_place=True)

        self.assertEqual(step.bound(items), [[1, "seen"], [2, "seen"]])


class AWrongWholeAnswerDoesNotEndTheCandidate(unittest.TestCase):
    """A tokenizer that returns nothing without its table and the right
    thing with it: the whole call answered wrongly, the per-item call too,
    and the shape that supplies the table was never tried."""

    def test_the_shape_with_the_side_input_is_still_tried(self):
        module = _written(
            "theirs",
            "def tokenize(texts, idfs=None):\n"
            "    if idfs is None:\n        return []\n"
            "    return [[str(x)] for x in texts]\n",
        )
        stage = Stage(
            "tokens",
            # Non-empty token lists: the per-item call without the table
            # returns `[]` per item, which a looser check read as tokens.
            produces=lambda v: isinstance(v, list) and bool(v) and all(
                isinstance(row, list) and bool(row) for row in v
            ),
            per_item=True,
            extras=("idfs",),
        )

        found = probe_sources(stage, callables_in([module]), (["a", "b"],), extras={"idfs": {"a": 1.0}})

        self.assertEqual([c.label for c, _ in found], ["theirs.tokenize"])
        self.assertIn("extra:idfs", found[0][0].plan)


    def test_a_failed_whole_call_still_tries_the_side_input(self):
        for validator in (lambda v: v == [["a"], ["b"]], None):
            with self.subTest(validator=validator):
                module = _written(
                    "theirs",
                    "def tokenize(text, idfs=None):\n"
                    "    if isinstance(text, list):\n        raise TypeError('one text at a time')\n"
                    "    if idfs is None:\n        return []\n"
                    "    return [text]\n",
                )
                stage = Stage("tokens", produces=validator, per_item=True, extras=("idfs",))
                found = probe_sources(
                    stage, callables_in([module]), (["a", "b"],), extras={"idfs": {"a": 1.0}}
                )
                self.assertEqual([c.label for c, _ in found], ["theirs.tokenize"])
                self.assertTrue(found[0][0].per_item)
                if validator is not None:
                    self.assertIn("extra:idfs", found[0][0].plan)
                    self.assertEqual(found[0][1], [["a"], ["b"]])
                else:
                    self.assertNotIn("extra:idfs", found[0][0].plan)


class OptionalFitStageTests(unittest.TestCase):
    """A fit stage marked optional is skipped when nothing computes it, and
    the stages after it bind from their input alone."""

    def test_missing_optional_fit_is_skipped_not_refused(self):
        from cogbench.pipeline import Role, Stage, _fits_of

        role = Role(
            "text",
            (
                Stage("idfs", fit=True, fixture=(["a b"],), optional=True),
                Stage("embed"),
            ),
        )
        found, failed = _fits_of(role, [], {}, [])
        self.assertEqual(found, [])
        self.assertIsNone(failed)

    def test_missing_required_fit_names_itself(self):
        from cogbench.pipeline import Role, Stage, _fits_of

        role = Role("text", (Stage("idfs", fit=True, fixture=(["a b"],)), Stage("embed")))
        found, failed = _fits_of(role, [], {}, [])
        self.assertEqual(found, [])
        self.assertEqual(failed, "idfs")
