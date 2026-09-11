"""The rule that decides which line of a traceback belongs to a student.

Every other part of the error report is assembled from what this returns, so
it is tested against real tracebacks rather than mocked ones: the whole value
of a compiler-style line is that the file and the number are right.
"""

from __future__ import annotations

import sys
import tempfile
import tracemalloc
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.raised import (  # noqa: E402
    Raised,
    message_of,
    root_of_their_code,
    where_it_raised,
)


def _raise_from(directory: Path, name: str, body: str) -> BaseException:
    """Run a real module out of ``directory`` and hand back what it raised."""

    path = directory / name
    path.write_text(body)
    namespace: dict = {}
    code = compile(path.read_text(), str(path), "exec")
    exec(code, namespace)
    try:
        namespace["go"]()
    except BaseException as error:  # noqa: BLE001 - the point of the fixture
        return error
    raise AssertionError("the fixture did not raise")


class TheirFrame(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp()).resolve()

    def test_the_line_reported_is_the_innermost_one_in_their_repository(self):
        error = _raise_from(
            self.tmp,
            "theirs.py",
            "def helper():\n"
            "    raise KeyError('song_list')\n"
            "\n"
            "\n"
            "def go():\n"
            "    helper()\n",
        )

        self.assertEqual(where_it_raised(error, self.tmp), ("theirs.py", 2))

    def test_a_raise_from_inside_the_standard_library_names_their_own_frame(self):
        # numpy, torch, and the standard library are where most of their
        # exceptions are actually constructed. The line worth printing is the
        # one they wrote that called it.
        error = _raise_from(
            self.tmp,
            "callers.py",
            "import json\n"
            "\n"
            "\n"
            "def go():\n"
            "    json.loads('{')\n",
        )

        self.assertEqual(where_it_raised(error, self.tmp), ("callers.py", 5))

    def test_nothing_is_reported_when_the_raise_never_entered_their_code(self):
        # The search calls candidates with input they may not take, and a call
        # with the wrong arity raises from the calling frame, which is ours.
        # Reporting that as their bug is the failure mode this rule exists to
        # prevent.
        try:
            (lambda one: one)()  # type: ignore[call-arg]
        except TypeError as error:
            self.assertIsNone(where_it_raised(error, self.tmp))
        else:
            raise AssertionError("the fixture did not raise")

    def test_the_file_is_reported_relative_to_the_repository(self):
        (self.tmp / "core").mkdir()
        error = _raise_from(
            self.tmp / "core",
            "match.py",
            "def go():\n    raise ValueError('no')\n",
        )

        self.assertEqual(where_it_raised(error, self.tmp), ("core/match.py", 2))

    def test_their_root_is_the_first_frame_below_ours(self):
        # What a scored run has: it knows where its own code ends and not
        # where the repository was checked out.
        error = _raise_from(
            self.tmp,
            "entry.py",
            "def go():\n    raise ValueError('no')\n",
        )

        self.assertEqual(root_of_their_code(error, Path(__file__).parent), self.tmp)


class TracebackLabels(unittest.TestCase):
    def test_pseudo_filename_does_not_replace_the_repository_frame(self):
        root = Path.cwd()
        namespace = {}
        exec(compile(
            "def go():\n    exec(\"raise ValueError('no')\")\n",
            str(root / "entry.py"), "exec",
        ), namespace)
        try:
            namespace["go"]()
        except ValueError as error:
            self.assertEqual(where_it_raised(error, root), ("entry.py", 2))
        else:
            self.fail("fixture did not raise")

    def test_pseudo_filename_does_not_invent_a_student_root(self):
        try:
            exec(compile("raise ValueError('no')", "<string>", "exec"))
        except ValueError as error:
            self.assertIsNone(root_of_their_code(error, Path(__file__).parent))

    def test_error_without_a_driver_frame_has_no_inferred_student_root(self):
        try:
            raise ValueError("host failure")
        except ValueError as error:
            self.assertIsNone(root_of_their_code(error, Path(__file__).parent / "driver"))

    def test_host_frames_before_the_driver_are_not_the_student_root(self):
        root = Path(__file__).parent
        namespace = {}
        for path, source in (
            (root / "team" / "student.py", "def student():\n    raise ValueError('no')"),
            (root / "driver" / "run.py", "def driver():\n    student()"),
            (root / "host" / "main.py", "def host():\n    driver()"),
        ):
            exec(compile(source, str(path), "exec"), namespace)
        try:
            namespace["host"]()
        except ValueError as error:
            self.assertEqual(root_of_their_code(error, root / "driver"), root / "team")


class Messages(unittest.TestCase):
    def test_the_type_is_kept_because_the_words_alone_say_too_little(self):
        self.assertEqual(message_of(KeyError("song_list")), "KeyError: 'song_list'")

    def test_an_exception_with_nothing_to_say_is_named_by_its_type(self):
        self.assertEqual(message_of(ValueError()), "ValueError")

    def test_a_broken_exception_formatter_keeps_the_original_type(self):
        for failure in (RuntimeError("broken formatter"), SystemExit(1)):
            with self.subTest(failure=type(failure).__name__):
                class BrokenMessage(Exception):
                    def __str__(self):
                        raise failure

                self.assertEqual(message_of(BrokenMessage()), "BrokenMessage")

    def test_only_the_first_line_survives(self):
        self.assertEqual(
            message_of(RuntimeError("first\nsecond")), "RuntimeError: first"
        )

    def test_a_long_message_is_capped(self):
        self.assertLessEqual(len(message_of(RuntimeError("x" * 500))), 200)

    def test_multiline_message_formatting_does_not_copy_every_line(self):
        error = RuntimeError("first\n" + "another line\n" * 100000)
        tracemalloc.start()
        try:
            self.assertEqual(message_of(error), "RuntimeError: first")
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 1024 * 1024)

    def test_whitespace_is_removed_before_the_bounded_first_line(self):
        error = RuntimeError(chr(0x2003) * 1000 + "first  \nsecond\n" + " " * 1000)
        self.assertEqual(message_of(error), "RuntimeError: first  ")


class Lines(unittest.TestCase):
    def test_a_record_prints_the_way_a_compiler_does(self):
        entry = Raised("whispers.py", 66, "whispers.create_graph", "AttributeError: no")

        self.assertEqual(
            entry.line_text(),
            "whispers.py:66: AttributeError: no (in whispers.create_graph)",
        )

    def test_a_notebook_is_named_without_a_line(self):
        # cogbench compiles a notebook from the cells that hold definitions,
        # so a traceback's line number counts lines of that module. Printed
        # against the .ipynb it sends a team to a line of JSON.
        entry = Raised("day4/CNN.ipynb", 0, "CNN.convolve", "AttributeError: no")

        self.assertEqual(
            entry.line_text(), "day4/CNN.ipynb: AttributeError: no (in CNN.convolve)"
        )


if __name__ == "__main__":
    unittest.main()
