from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.report import render_check, render_survey  # noqa: E402
from cogbench.resolve import Attempt, Submission  # noqa: E402
from cogbench.verdict import Observation, not_wired, scored  # noqa: E402

SURVEY = {
    "root": "/tmp/team/Week1",
    "rootReason": "directory name matches this week",
    "modules": [
        {"name": "spectrogram", "path": "/tmp/team/Week1/spectrogram.py", "origin": "file"},
        {"name": "database_design", "path": "/tmp/team/Week1/database_design.ipynb", "origin": "notebook"},
    ],
    "skipped": [
        {
            "name": "fingerprint_maker",
            "path": "/tmp/x",
            "reason": "missing_dependency",
            "detail": "imports ipynb, which is not installed here",
            "missing": "ipynb",
        },
        {
            "name": "test_five_songs",
            "path": "/tmp/y",
            "reason": "raised",
            "detail": "FileNotFoundError: data/raw/test_song.mp3",
            "missing": None,
        },
    ],
}


class SurveyTests(unittest.TestCase):
    def test_it_says_where_it_looked_and_why(self):
        text = "\n".join(render_survey(SURVEY))
        self.assertIn("Week1", text)
        self.assertIn("directory name matches this week", text)

    def test_a_notebook_says_its_cells_were_not_run(self):
        """A function lifted from a notebook can fail on a global its cells
        built, so where it came from is part of reading the failure."""

        text = "\n".join(render_survey(SURVEY))
        self.assertIn("database_design", text)
        self.assertIn("the cells were not run", text)

    def test_a_missing_package_is_named_and_a_broken_script_is_counted(self):
        """One repository skips fifteen of its own scripts for want of audio
        files. Naming each buries the skip that matters."""

        text = "\n".join(render_survey(SURVEY))

        self.assertIn("fingerprint_maker", text)
        self.assertIn("ipynb", text)
        self.assertNotIn("test_five_songs", text)
        self.assertIn("1 script", text)

    def test_an_empty_repository_says_it_read_nothing(self):
        text = "\n".join(render_survey({"root": "/tmp/team", "modules": [], "skipped": []}))
        self.assertIn("nothing", text)


class CheckTests(unittest.TestCase):
    def _ready(self) -> Submission:
        trace = (
            Observation("spectrogram", "spectrogram.make_spectrogram", "", ""),
            Observation("peaks", "fingerprint.find_peaks", "", ""),
        )
        verdict = scored("ready", 1.0)
        verdict = type(verdict)(verdict.status, "Your code is wired up and ready to score.", trace)
        return Submission(
            verdict,
            attempt=Attempt("database.add", "match.query", 2),
            chain=(),
            attempts_tried=35,
            enroll=lambda *a: None,
            query=lambda *a: None,
        )

    def test_a_ready_repository_ends_with_the_command_to_run(self):
        lines = render_check(
            benchmark="audio-identification",
            python_version="3.11.15",
            hosted_python="3.8",
            benchmark_ready=True,
            repository="team/capstone",
            submission=self._ready(),
            survey=SURVEY,
        )
        text = "\n".join(lines)

        self.assertIn("cogworks run --benchmark audio-identification", text)
        self.assertIn("database.add", text)
        self.assertIn("match.query", text)

    def test_the_hosted_interpreter_is_named_when_it_differs(self):
        """A team on 3.11 whose hidden run is 3.8 needs to know before the
        run, not from a failure afterwards."""

        text = "\n".join(
            render_check(
                benchmark="audio-identification",
                python_version="3.11.15",
                hosted_python="3.8",
                benchmark_ready=True,
                repository="team/capstone",
                submission=self._ready(),
            )
        )
        self.assertIn("hosted python", text)
        self.assertIn("3.8", text)

    def test_the_same_interpreter_is_not_mentioned_twice(self):
        text = "\n".join(
            render_check(
                benchmark="audio-identification",
                python_version="3.8.20",
                hosted_python="3.8.20",
                benchmark_ready=True,
                repository="team/capstone",
                submission=self._ready(),
            )
        )
        self.assertNotIn("hosted python", text)

    def test_a_refusal_ends_with_the_next_step_and_no_run_command(self):
        submission = Submission(
            not_wired(
                "fingerprint",
                "peaks",
                (Observation("spectrogram", "audio_parser.spectrogram_conversion", "", ""),),
                last_returned="an array of shape (1025, 171)",
                next_step="Add ipynb to a requirements.txt at the root of your repository.",
            )
        )

        text = "\n".join(
            render_check(
                benchmark="audio-identification",
                python_version="3.11.15",
                hosted_python="3.8",
                benchmark_ready=True,
                repository="team/capstone",
                submission=submission,
                survey=SURVEY,
            )
        )

        self.assertIn("(1025, 171)", text)
        self.assertIn("requirements.txt", text)
        self.assertNotIn("cogworks run", text)

    def test_a_missing_benchmark_says_so_rather_than_reporting_nothing(self):
        text = "\n".join(
            render_check(
                benchmark="audio-identification",
                python_version="3.11.15",
                hosted_python=None,
                benchmark_ready=False,
                repository=None,
                submission=None,
            )
        )
        self.assertIn("not installed", text)
        self.assertIn("not a git repository", text)


if __name__ == "__main__":
    unittest.main()
