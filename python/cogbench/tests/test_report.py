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


class WhenTheCheckCouldNotLook(unittest.TestCase):
    """A run stopped by our own missing packages says so once, not twice.

    The gap note ("this report may have read less than the graded run") and
    the could_not_look verdict ("this check could not read 5 of your files")
    are the same fact at two levels of detail. Printing both makes a reader
    work out that two paragraphs are one thing.
    """

    def _stopped(self):
        from cogbench.resolve import Submission
        from cogbench.verdict import Coverage, could_not_look

        coverage = Coverage(
            read=("recognizer",),
            skipped=(("whispers", "imports cv2, which is not installed here", "ours"),),
        )
        return Submission(could_not_look(coverage, next_step="Install cv2 here."))

    def test_the_general_caveat_yields_to_the_specific_verdict(self):
        text = "\n".join(
            render_check(
                benchmark="vision-clustering",
                python_version="3.11.15",
                hosted_python="3.11",
                benchmark_ready=True,
                repository="team/vision",
                submission=self._stopped(),
                local_gap_note="12 packages the graded run installs are missing here.",
            )
        )
        self.assertIn("could not read 1 of your files", text)
        self.assertNotIn("12 packages", text)

    def test_the_caveat_still_prints_when_the_run_was_not_stopped_by_it(self):
        """A repository that resolved anyway still deserves the warning: the
        graded run may read more than this did."""

        text = "\n".join(
            render_check(
                benchmark="vision-clustering",
                python_version="3.11.15",
                hosted_python="3.11",
                benchmark_ready=True,
                repository="team/vision",
                submission=self._ready_submission(),
                local_gap_note="12 packages the graded run installs are missing here.",
            )
        )
        self.assertIn("12 packages", text)

    def _ready_submission(self):
        from cogbench.resolve import Attempt, Submission
        from cogbench.verdict import scored

        return Submission(
            scored("ready", 1.0),
            attempt=Attempt("database.add", "match.query", 2),
            chain=(),
            attempts_tried=1,
            enroll=lambda *a: None,
            query=lambda *a: None,
        )

    def test_the_headline_does_not_repeat_the_next_step(self):
        """Both listed the modules, so the reader compared two lists to find
        out they were the same list."""

        verdict = self._stopped().verdict
        self.assertNotIn("whispers", verdict.headline)
        self.assertIn("whispers", verdict.coverage.ours)
