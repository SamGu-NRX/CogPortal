from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.models import LocalReport, RepositoryState  # noqa: E402
from cogbench.plugins import benchmark_install_command  # noqa: E402
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

    def test_chain_labels_are_plain_strings_and_render_without_a_trace(self):
        import pickle
        from cogbench.pipeline import Candidate

        submission = Submission(
            scored("ready", 1.0),
            chain=(Candidate("audio.fingerprint", lambda value: value, "audio"),),
        )
        report = pickle.loads(pickle.dumps(submission.report()))
        self.assertEqual(report.chain, ("audio.fingerprint",))
        self.assertIs(type(report.chain[0]), str)
        text = "\n".join(render_check(
            benchmark="audio-identification",
            python_version="3.11.15",
            hosted_python=None,
            benchmark_ready=True,
            repository="team/audio",
            submission=report,
        ))
        self.assertIn("audio.fingerprint", text)
        self.assertIn("Wired up:", text)

    def test_a_ready_repository_ends_with_the_command_to_run(self):
        lines = render_check(
            benchmark="audio-identification",
            python_version="3.11.15",
            hosted_python="3.8",
            benchmark_ready=True,
            repository="team/capstone",
            submission=self._ready().report(),
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
                submission=self._ready().report(),
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
                submission=self._ready().report(),
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
                submission=submission.report(),
                survey=SURVEY,
            )
        )

        self.assertIn("(1025, 171)", text)
        self.assertIn("requirements.txt", text)
        self.assertNotIn("cogworks run", text)

    def test_a_benchmark_that_cannot_be_searched_does_not_claim_a_package_was_used(self):
        """Before this existed, a Week 3 repository with no package and no
        adapter was told "your submission is registered as an installed
        package, so it was used as is". Nothing was installed and nothing
        was used; the benchmark simply had no discovery spec."""

        text = "\n".join(
            render_check(
                benchmark="language-search",
                python_version="3.11.15",
                hosted_python=None,
                benchmark_ready=True,
                repository="team/repo",
                submission=None,
                submission_source=None,
            )
        )
        self.assertNotIn("used as is", text)
        self.assertNotIn("installed package", text)
        self.assertIn("does not yet describe its task", text)
        self.assertIn("benchmark_adapter.py", text)

    def test_an_installed_entry_point_is_named_but_not_claimed_as_theirs(self):
        """This report used to say an installed package "was used as is".

        It is not used: `run` scores a file in this repository or what
        discovery bound, never an entry point, because an entry point belongs
        to whatever was pip-installed. Saying it was used sent a
        vision-recognition repository through a passing check and into a run
        that refused it.
        """

        text = "\n".join(
            render_check(
                benchmark="language-search",
                python_version="3.11.15",
                hosted_python=None,
                benchmark_ready=True,
                repository="team/repo",
                submission=None,
                submission_source=None,
                installed_reference=True,
            )
        )
        self.assertNotIn("used as is", text)
        self.assertIn("is installed here", text)
        self.assertIn("not scored as your work", text)
        self.assertIn("does not yet describe its task", text)

    def test_a_benchmark_that_could_not_describe_its_task_says_why(self):
        """Measured on a machine that had not fetched the week 3 data: the
        spec build raised, the reason was swallowed, and the report told the
        student to write an adapter instead of downloading the dataset."""

        text = "\n".join(
            render_check(
                benchmark="language-search",
                python_version="3.11.15",
                hosted_python=None,
                benchmark_ready=True,
                repository="team/repo",
                submission=None,
                submission_source=None,
                search_unavailable=(
                    "captions_train2014.json is not cached. Run `cogworks test` to fetch it."
                ),
            )
        )
        # `_wrapped` breaks the paragraph, so match on the unwrapped text.
        flat = " ".join(text.split())
        self.assertIn("could not describe its task just now", flat)
        self.assertIn("cogworks test", flat)
        self.assertNotIn("a submission must be declared", text)
        self.assertNotIn("benchmark_adapter.py", text)

    def test_a_repository_that_ended_the_process_gets_a_report_not_silence(self):
        """The command whose job is to explain a repository printed nothing at
        all when reading it aborted the interpreter."""

        text = "\n".join(
            render_check(
                benchmark="audio-identification",
                python_version="3.11.15",
                hosted_python=None,
                benchmark_ready=True,
                repository="team/repo",
                submission=None,
                unread_detail="segfaulted",
            )
        )
        self.assertIn("ended the process before it finished", text)
        self.assertIn("segfaulted", text)
        self.assertIn("one at a time", text)

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
        # The exact command is pinned in test_plugins.py against the
        # submodule this checkout carries. What matters here is that the
        # report prints it rather than leaving the reader to find it.
        self.assertIn(benchmark_install_command("audio-identification"), text)

    def test_an_unknown_missing_benchmark_keeps_the_current_next_step(self):
        lines = render_check(
            benchmark="not-a-shipped-benchmark",
            python_version="3.11.15",
            hosted_python=None,
            benchmark_ready=False,
            repository=None,
            submission=None,
        )
        self.assertEqual(lines[-1], "Install it, then run this again.")


class LocalReportDiagnosticTests(unittest.TestCase):
    def test_a_four_hundred_character_two_sentence_note_is_not_cut_mid_word(self):
        first = "First " + "alpha " * 32 + "ends."
        second = "Second " + "bravo " * 32 + "ends."
        note = first + " " + second
        self.assertGreater(len(note), 400)

        report = LocalReport.create(
            benchmark_id="audio-identification",
            benchmark_version=1,
            contract_version="cogworks.submissions.v2",
            sdk_version="0.2.0",
            plugin_version="0.2.0",
            repository=RepositoryState(None, None, None, False),
            started_at=1,
            finished_at=2,
            metrics=[],
            diagnostics=[note],
            predictions=[],
        )

        self.assertEqual(report.diagnostics, [first, second])
        self.assertTrue(all(len(line) <= 240 for line in report.diagnostics))


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
                submission=self._stopped().report(),
                local_gap_note="12 packages the graded run installs are missing here.",
            )
        )
        self.assertIn("could not read one of your files", text)
        self.assertIn("missing a package it imports", text)
        self.assertNotIn("12 packages", text)

    def test_multiple_unreadable_files_keep_the_plural_headline(self):
        from cogbench.verdict import Coverage, could_not_look

        coverage = Coverage(skipped=(("one", "missing cv2", "ours"), ("two", "missing scipy", "ours")))
        verdict = could_not_look(coverage)
        self.assertIn("could not read 2 of your files", verdict.headline)
        self.assertIn("missing packages they import", verdict.headline)

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
                submission=self._ready_submission().report(),
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
