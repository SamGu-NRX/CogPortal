from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.pipeline import (  # noqa: E402
    Candidate,
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


if __name__ == "__main__":
    unittest.main()
