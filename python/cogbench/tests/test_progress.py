from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.progress import Progress, TerminalProgress  # noqa: E402


class _Terminal(io.StringIO):
    """A stream that claims to be a terminal, so drawing is exercised."""

    def isatty(self) -> bool:
        return True


class _Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class SilenceTests(unittest.TestCase):
    def test_a_pipe_gets_no_escape_codes(self):
        """Redirected to a file, the spinner would be thousands of escape
        sequences in a log nobody reads."""

        stream = io.StringIO()  # a plain StringIO is not a tty
        progress = TerminalProgress(stream, clock=_Clock())
        progress.phase("Looking for your code")
        for done in range(1, 200):
            progress.attempts(done, 200)
        progress.done()

        self.assertEqual(stream.getvalue(), "")

    def test_the_default_reporter_does_nothing_and_raises_nothing(self):
        """resolve() is called by the Modal runner and the portal worker,
        neither of which has anywhere to put a spinner."""

        progress = Progress()
        progress.phase("x")
        progress.found("peaks", "theirs.find_peaks")
        progress.attempts(1, 2)
        progress.note("hm")
        progress.done()

    def test_a_closed_stream_disables_every_progress_callback(self):
        stream = io.StringIO()
        stream.close()
        progress = TerminalProgress(stream, clock=_Clock())
        self.assertFalse(progress.enabled)
        progress.phase("Looking")
        progress.attempts(1, 10)
        progress.found("peaks", "theirs.find_peaks")
        progress.note("A note")
        progress.done()

    def test_an_unavailable_terminal_check_disables_progress(self):
        class Unavailable(_Terminal):
            def isatty(self):
                raise OSError("terminal disconnected")

        with Unavailable() as stream:
            progress = TerminalProgress(stream, clock=_Clock())
            self.assertFalse(progress.enabled)
            progress.phase("Looking")
            progress.attempts(1, 10)
            progress.done()
            self.assertEqual(stream.getvalue(), "")

    def test_a_broken_stream_does_not_take_the_run_with_it(self):
        stream = _Terminal()
        progress = TerminalProgress(stream, clock=_Clock())
        progress.phase("Looking")
        stream.close()
        progress.attempts(1, 10)  # must not raise
        progress.done()


class DrawingTests(unittest.TestCase):
    def setUp(self):
        self.stream = _Terminal()
        self.clock = _Clock()
        self.progress = TerminalProgress(self.stream, clock=self.clock)

    def test_a_bound_stage_is_printed_permanently(self):
        """What stays on screen afterwards should be a record of what
        happened, not the last frame of an animation."""

        self.progress.phase("Looking for your code")
        self.progress.found("peaks", "fingerprint.find_peaks")
        self.progress.attempts(1, 100)
        self.progress.done()

        text = self.stream.getvalue()
        self.assertIn("fingerprint.find_peaks", text)
        self.assertIn("peaks", text)

    def test_the_live_line_is_erased_rather_than_left_behind(self):
        self.progress.phase("Looking")
        self.progress.attempts(1, 100)
        self.progress.done()

        self.assertTrue(self.stream.getvalue().endswith("\r\x1b[2K"))

    def test_frames_are_dropped_so_the_search_is_not_slowed_by_drawing(self):
        """The draw sits inside the loop that is already the slow part."""

        self.progress.phase("Looking")
        before = len(self.stream.getvalue())
        for done in range(1, 50):  # clock never advances
            self.progress.attempts(done, 1000)
        drawn = self.stream.getvalue()[before:].count("\x1b[2K")

        self.assertLessEqual(drawn, 2)

    def test_the_last_attempt_always_draws(self):
        """Stopping on 999/1000 leaves a student wondering whether the final
        pairing hung."""

        self.progress.phase("Looking")
        self.progress.attempts(1, 1000)
        self.progress.attempts(1000, 1000)  # same instant, but the last one

        self.assertIn("1,000/1,000", self.stream.getvalue())

    def test_the_bar_fills_as_the_search_advances(self):
        self.progress.phase("Looking")
        self.progress.attempts(1, 100)
        self.clock.now += 1
        self.progress.attempts(50, 100)
        self.progress.done()

        text = self.stream.getvalue()
        self.assertIn("[" + "#" * 12 + "." * 12 + "]", text)


class EstimateTests(unittest.TestCase):
    def setUp(self):
        self.stream = _Terminal()
        self.clock = _Clock()
        self.progress = TerminalProgress(self.stream, clock=self.clock)
        self.progress.phase("Looking")

    def _line(self) -> str:
        return self.stream.getvalue().rsplit("\x1b[2K", 1)[-1]

    def test_the_estimate_says_it_is_a_rate_and_not_a_bound(self):
        """The attempts left are a ceiling; the seconds are an average
        multiplied out, so the line must not read like a promise."""

        self.clock.now = 100.0
        self.progress.attempts(1000, 10000)

        line = self._line()
        self.assertIn("at this rate", line)
        self.assertNotIn("at most", line)
        self.assertIn("15m 00s", line)  # 0.1s each, 9000 to go

    def test_one_slow_first_attempt_does_not_become_the_estimate(self):
        """The first pairing warms their imports and their first numba call.
        Extrapolating from it announced two minutes for a 23-second search."""

        self.clock.now = 2.0
        self.progress.attempts(1, 6320)

        self.assertNotIn("at this rate", self._line())

    def test_a_search_about_to_end_is_not_given_a_countdown(self):
        """Under a few seconds, the estimate is noise: it may well finish
        before the line is read."""

        self.clock.now = 0.2
        self.progress.attempts(400, 500)

        self.assertNotIn("at this rate", self._line())

    def test_no_estimate_before_there_is_evidence_for_one(self):
        self.clock.now = 5.0
        self.progress.attempts(0, 100000)

        self.assertNotIn("at this rate", self._line())


if __name__ == "__main__":
    unittest.main()
