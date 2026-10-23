import io
import queue
import unittest
from unittest.mock import patch

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_prepared_restore import functions
from cogbench.cli import _LiveRun

_read_v2_progress = functions("_read_v2_progress", time=__import__("time")).get("_read_v2_progress")


class _Process:
    def __init__(self, lines):
        self.stdout = io.BytesIO("".join(lines).encode())


class _Reporter:
    def __init__(self):
        self.events = []

    def status(self, phase, current=None, total=None):
        self.events.append((phase, current, total))


class HostedProgressTests(unittest.TestCase):
    def test_reads_progress_before_process_finishes_and_preserves_results(self):
        reporter = _Reporter()
        result = {"predictions": ["same"]}
        _read_v2_progress(_Process(["COG_PROGRESS: 1\n", "COG_PROGRESS: 2\n"]), reporter, 2)
        self.assertEqual(reporter.events, [("evaluating", 1, 2), ("evaluating", 2, 2)])
        self.assertEqual(result, {"predictions": ["same"]})

    def test_clamps_monotonic_and_ignores_malformed_or_forged_lines(self):
        reporter = _Reporter()
        _read_v2_progress(
            _Process([
                "COG_PROGRESS: 99\n", "COG_PROGRESS: 4\n", "COG_PROGRESS: nope\n",
                "COG_ERROR: {\"category\": \"platform\"}\n", "COG_PROGRESS: -2\n",
            ]), reporter, 4
        )
        self.assertEqual([event[1] for event in reporter.events], [4])

    def test_throttles_progress_on_a_monotonic_clock(self):
        reporter = _Reporter()
        clock = iter([0.0, 0.1, 0.2, 0.6]).__next__
        _read_v2_progress(
            _Process(["COG_PROGRESS: 1\n", "COG_PROGRESS: 2\n", "COG_PROGRESS: 3\n", "COG_PROGRESS: 4\n"]),
            reporter, 4, clock=clock, throttle_seconds=0.5,
        )
        self.assertEqual([event[1] for event in reporter.events], [1, 4])

    def test_full_local_queue_drops_progress_instead_of_raising(self):
        live = _LiveRun("portal", "token", "session")
        with live._lock:
            for _ in range(live._events.maxsize):
                live._events.put_nowait((object(), None))
            live._queue_locked({"type": "progress", "phase": "evaluating", "code": "evaluation.progress"})
        self.assertEqual(live._events.qsize(), live._events.maxsize)


if __name__ == "__main__":
    unittest.main()
