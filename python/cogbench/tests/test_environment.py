"""What a local dry run cannot see, and whether we say so accurately.

`cogworks check` imports a repository on the student's machine. The graded run
imports it in a Modal image with a much larger package set, so the two read
different amounts of the same repository: a module whose import does not
resolve locally is skipped here and read there. Measured on a developer laptop
against the Week 2 image, twelve of the image's packages were absent locally.

Nothing said so, and a report that quietly describes less of a repository than
the graded run will is the kind of plausible-but-incomplete answer this
platform is supposed to refuse. These tests cover the reporter that closes
that gap, and they check the two ways it could be wrong: naming a package that
is actually here, and staying silent about one that is not.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench import environment  # noqa: E402


class MissingHereNamesTheRightPackages(unittest.TestCase):
    """A synthetic list, so the result does not depend on what this machine
    happens to have installed. `sys` and `json` are in the standard library and
    are always importable; the absent names cannot exist."""

    def test_it_names_only_what_cannot_be_imported(self):
        absent = environment.missing_here(
            ["sys", "definitely_absent_alpha", "json", "definitely_absent_beta"]
        )
        self.assertEqual(
            absent, ("definitely_absent_alpha", "definitely_absent_beta")
        )

    def test_an_importable_package_is_never_reported_missing(self):
        """The failure that matters most. Telling a student to install
        something they already have sends them to debug their environment
        over a claim we got wrong."""

        self.assertEqual(environment.missing_here(["sys", "json", "os"]), ())

    def test_it_keeps_the_order_it_was_given(self):
        """The names reach a student in this order, so a stable one keeps two
        runs of the same command comparable."""

        absent = environment.missing_here(["zzz_absent", "aaa_absent"])
        self.assertEqual(absent, ("zzz_absent", "aaa_absent"))

    def test_finding_a_package_does_not_import_it(self):
        """`find_spec` locates a module without executing it. Importing to
        find out would run package initialisation for every heavy package on
        a track's list, which on a machine with torch costs seconds of a
        command students run every few minutes."""

        before = set(sys.modules)
        environment.missing_here(sorted(environment.student_modules("week2")))
        added = set(sys.modules) - before
        self.assertNotIn("torch", added)
        self.assertNotIn("cv2", added)


class TheGapIsReportedPerTrack(unittest.TestCase):
    """One list cannot describe three images. Week 1 is an audio stack on a
    3.8 venv, Week 2 is a vision stack on 3.11, and telling a Week 1 student
    that the graded run has torch is false."""

    def test_each_benchmark_reports_only_its_own_track(self):
        week1 = environment.student_modules("week1")
        week2 = environment.student_modules("week2")
        self.assertIn("librosa", week1)
        self.assertNotIn("librosa", week2)
        self.assertIn("torch", week2)
        self.assertNotIn("torch", week1)

    def test_an_unknown_benchmark_reports_nothing_rather_than_guessing(self):
        """A package list for the wrong week is worse than no list: it sends a
        student to install something the graded run does not have."""

        self.assertEqual(environment.local_gap("not-a-real-benchmark"), ())
        self.assertEqual(environment.track_for("not-a-real-benchmark"), "")

    def test_every_shipped_benchmark_id_maps_to_a_track(self):
        """A benchmark whose track is unknown reports no gap at all, which
        looks exactly like a machine that has everything. Each id here is an
        entry-point name from a benchmark's pyproject."""

        for benchmark in (
            "audio-identification",
            "vision-recognition",
            "vision-clustering",
            "language-search",
        ):
            self.assertIn(
                environment.track_for(benchmark),
                environment.TRACKS,
                "{} has no track, so its local gap would silently be empty"
                .format(benchmark),
            )


class TheNoteSaysWhatTheStudentNeedsToKnow(unittest.TestCase):
    def test_it_names_every_missing_package(self):
        """A student cannot check a claim about "some packages"."""

        note = environment.gap_note("vision-recognition", ("torch", "cv2"))
        self.assertIn("torch", note)
        self.assertIn("cv2", note)

    def test_it_says_the_local_report_may_have_read_less(self):
        """The consequence is the part that changes what they do. Without it
        this is trivia about package lists."""

        note = environment.gap_note("vision-recognition", ("torch", "cv2"))
        self.assertIn("read less of your repository", note)

    def test_it_does_not_blame_the_repository(self):
        """Nothing is broken. Their code is fine and the graded run is
        unaffected, so the note must not read as a failure of theirs."""

        note = environment.gap_note("vision-recognition", ("torch", "cv2"))
        for word in ("error", "failed", "problem with your", "fix"):
            self.assertNotIn(word, note.lower())

    def test_nothing_missing_says_nothing(self):
        """A caller prints this unconditionally, so an empty gap has to
        produce no paragraph rather than a reassuring one."""

        self.assertEqual(environment.gap_note("vision-recognition", ()), "")

    def test_one_missing_package_reads_as_one(self):
        note = environment.gap_note("audio-identification", ("librosa",))
        self.assertIn("One package", note)
        self.assertNotIn("1 packages", note)

    def test_no_em_dashes_anywhere_in_student_facing_text(self):
        """House style (docs/design/voice.md), and this is text a student reads.

        The two characters are written as unicode escapes (U+2014 em dash,
        U+2013 en dash) so that this file, which is about the rule, does not
        itself contain the thing it forbids.
        """

        for count in range(1, 4):
            note = environment.gap_note(
                "vision-recognition", tuple("pkg{}".format(i) for i in range(count))
            )
            self.assertNotIn("\u2014", note)
            self.assertNotIn("\u2013", note)


class TheAdviceMatchesTheTrack(unittest.TestCase):
    """A missing package produces opposite advice depending on whether the
    graded run has it: install it here, or declare it so the graded run gets
    it. That question has three answers, one per image, and the global list
    that used to answer it got most of them wrong."""

    def setUp(self):
        from cogbench import resolve

        self.next_step = resolve._next_step_for

    def test_a_week2_package_missing_locally_says_install_it_here(self):
        step = self.next_step("missing_dependency", "torch", "vision-recognition")
        self.assertIn("the graded run has it", step)

    def test_the_same_package_on_week3_says_declare_it(self):
        """torch is in the Week 2 image and neither 3.8 venv. Telling a Week 3
        student the graded run has it sends them to install a package their
        run will not have, and the module stays skipped."""

        step = self.next_step("missing_dependency", "torch", "language-search")
        self.assertIn("requirements.txt", step)
        self.assertNotIn("the graded run has it", step)

    def test_nltk_is_never_claimed_to_be_present(self):
        """The course's Week 3 setup installs nltk and no image does. The old
        global list contained it, so a Week 3 student whose module imported
        nltk was told to install it locally and run again, which fixes their
        laptop and leaves the graded run skipping the same module."""

        step = self.next_step("missing_dependency", "nltk", "language-search")
        self.assertIn("requirements.txt", step)
        self.assertNotIn("the graded run has it", step)

    def test_an_unknown_benchmark_advises_declaring_rather_than_installing(self):
        """The safe direction when the track is unknown. Declaring a package
        costs a line in a file; being told the graded run has a package it
        does not costs the run."""

        step = self.next_step("missing_dependency", "torch", "")
        self.assertIn("requirements.txt", step)


class TheManifestDescribesTheImages(unittest.TestCase):
    """These are the facts the rest of the module rests on, so they are
    pinned rather than assumed."""

    def test_week2_carries_networkx_and_the_others_do_not(self):
        """The reason the networkx stub was removed. If this ever flips, the
        note in `cogbench.discover.STUBBED_MODULES` stops being true."""

        self.assertIn("networkx", environment.student_modules("week2"))
        self.assertNotIn("networkx", environment.student_modules("week1"))
        self.assertNotIn("networkx", environment.student_modules("week3"))

    def test_nltk_is_absent_everywhere_despite_being_prescribed(self):
        """The course's Week 3 setup installs nltk and no image does
        (docs/capstones/environment.md:218). Recorded as a test because the
        old global package list asserted the opposite, and told a Week 3
        student the graded run had it."""

        self.assertNotIn("nltk", environment.all_student_modules())

    def test_import_names_are_recorded_not_distribution_names(self):
        """`pip install scikit-learn` gives you `import sklearn`. A check that
        compares a student's import against distribution names matches nothing
        and reports that as absence."""

        modules = environment.student_modules("week2")
        self.assertIn("sklearn", modules)
        self.assertNotIn("scikit-learn", modules)
        self.assertIn("cv2", modules)
        self.assertIn("PIL", modules)

    def test_the_venv_command_installs_pip_for_the_build_step(self):
        """The next build step runs `python -m pip install --no-deps
        /opt/weekN` inside this venv, so pip has to be there. It is build
        machinery rather than a course package, which is why it is in the
        command and not in the package data."""

        command = environment.venv_install_command("week1")
        self.assertIn(" pip ", command)
        self.assertNotIn("pip", environment.student_modules("week1"))

    def test_a_track_without_a_venv_refuses_to_produce_one(self):
        """Week 2 student code runs on the image interpreter directly. A
        command claiming to fill a 3.8 venv for it would install into a
        Python nothing runs."""

        with self.assertRaises(KeyError):
            environment.venv_install_command("week2")


if __name__ == "__main__":
    unittest.main()
