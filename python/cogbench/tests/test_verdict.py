from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.verdict import (  # noqa: E402
    NOT_READ,
    NOT_WIRED,
    NOTHING_HERE,
    SCORED,
    WIRED_BUT_WRONG,
    Observation,
    describe,
    not_read,
    not_wired,
    nothing_here,
    scored,
    wired_but_wrong,
)

TRACE = (
    Observation(
        "spectrogram",
        "spectrogram.make_spectrogram",
        "an array of shape (132300,), 44100",
        "a tuple of 3, starting with an array of shape (2049, 63)",
    ),
    Observation(
        "peaks",
        "fingerprint.find_peaks",
        "an array of shape (2049, 63)",
        "an array of shape (355, 2)",
    ),
)


class DescribeTests(unittest.TestCase):
    """A student checks a shape against what their next function expects."""

    def test_an_array_is_its_shape(self):
        class Fake:
            shape = (2049, 63)

        self.assertEqual(describe(Fake()), "an array of shape (2049, 63)")

    def test_a_long_list_is_its_length_and_first_entry(self):
        self.assertEqual(
            describe([(1, 2), (3, 4), (5, 6)]), "a list of 3, starting (1, 2)"
        )

    def test_a_list_of_arrays_leads_with_the_inner_shape(self):
        class Fake:
            shape = (4, 4)

        self.assertIn("starting with an array of shape (4, 4)", describe([Fake()]))

    def test_an_empty_result_says_so_plainly(self):
        """An empty list is the single most common symptom of a wrong
        threshold, so it must never be summarised away."""

        self.assertEqual(describe([]), "an empty list")

    def test_a_long_value_is_cut_rather_than_wrapped(self):
        self.assertLessEqual(len(describe("x" * 500)), 160)


class WiredButWrongTests(unittest.TestCase):
    """The case a scoreboard cannot express: it ran, and it is wrong."""

    def test_the_headline_states_both_answers_and_stops(self):
        verdict = wired_but_wrong("a song it just enrolled", "song_02", "song_07", TRACE)

        self.assertEqual(verdict.status, WIRED_BUT_WRONG)
        self.assertIn("song_07", verdict.headline)
        self.assertIn("song_02", verdict.headline)

    def test_it_never_guesses_at_a_cause(self):
        """A programmatic system cannot know whether the fanout is too narrow
        or the database key is wrong, and a confident wrong explanation costs
        more than none."""

        verdict = wired_but_wrong("a song it just enrolled", "song_02", "song_07", TRACE)
        text = verdict.render().lower()

        for word in ("because", "likely", "probably", "try ", "should", "suggest"):
            self.assertNotIn(word, text)

    def test_it_offers_no_next_step_because_the_bug_is_theirs(self):
        verdict = wired_but_wrong("a case", "a", "b", TRACE)
        self.assertEqual(verdict.next_step, "")

    def test_the_trace_is_the_reproduction(self):
        verdict = wired_but_wrong("a case", "a", "b", TRACE)
        rendered = verdict.render()

        self.assertIn("spectrogram.make_spectrogram", rendered)
        self.assertIn("fingerprint.find_peaks", rendered)
        self.assertIn("(2049, 63)", rendered)

    def test_this_is_theirs_to_fix_and_not_a_platform_failure(self):
        verdict = wired_but_wrong("a case", "a", "b", TRACE)
        self.assertTrue(verdict.is_theirs_to_fix)
        self.assertFalse(verdict.is_failure)


class NotWiredTests(unittest.TestCase):
    def test_the_headline_names_the_handoff_that_failed(self):
        """"We could not score you" is not usable. "Nothing took an array of
        shape (513, 259)" is."""

        verdict = not_wired(
            "fingerprinting",
            "peaks",
            TRACE[:1],
            last_returned="an array of shape (513, 259)",
        )

        self.assertEqual(verdict.status, NOT_WIRED)
        self.assertIn("(513, 259)", verdict.headline)
        self.assertIn("spectrogram.make_spectrogram", verdict.headline)

    def test_with_nothing_bound_it_says_the_first_step_found_no_candidate(self):
        verdict = not_wired("fingerprinting", "spectrogram", ())
        self.assertIn("spectrogram", verdict.headline)
        self.assertEqual(verdict.trace, ())

    def test_a_wiring_failure_is_ours_to_explain_not_theirs_to_debug(self):
        verdict = not_wired("fingerprinting", "peaks", TRACE[:1])
        self.assertTrue(verdict.is_failure)
        self.assertFalse(verdict.is_theirs_to_fix)


class OtherOutcomeTests(unittest.TestCase):
    def test_a_score_reads_as_a_result_not_an_error(self):
        verdict = scored("identification_score", 0.65625)
        self.assertEqual(verdict.status, SCORED)
        self.assertIn("0.6562", verdict.headline)
        self.assertFalse(verdict.is_failure)

    def test_an_unreadable_module_names_the_module_and_the_reason(self):
        verdict = not_read("fingerprint_maker", "imports ipynb, which is not installed here")
        self.assertEqual(verdict.status, NOT_READ)
        self.assertIn("fingerprint_maker", verdict.headline)
        self.assertIn("ipynb", verdict.headline)

    def test_an_empty_repository_is_stated_plainly(self):
        verdict = nothing_here("Week3-Capstone")
        self.assertEqual(verdict.status, NOTHING_HERE)
        self.assertIn("no Python", verdict.headline)
        self.assertTrue(verdict.next_step)

    def test_every_verdict_survives_serialisation(self):
        for verdict in (
            scored("x", 1.0),
            wired_but_wrong("a", "b", "c", TRACE),
            not_wired("a", "b", TRACE[:1]),
            not_read("m", "r"),
            nothing_here("r"),
        ):
            record = verdict.to_dict()
            self.assertIn(record["status"], {
                SCORED, WIRED_BUT_WRONG, NOT_WIRED, NOT_READ, NOTHING_HERE
            })
            self.assertTrue(record["headline"])


if __name__ == "__main__":
    unittest.main()
