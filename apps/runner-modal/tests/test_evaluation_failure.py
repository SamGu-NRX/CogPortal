"""What a failed evaluation tells the team, and what it must not decide.

A hosted Recognition run (B-44) failed inside the benchmark's own replay and
reached the run page as "'NoneType' object is not subscriptable": no class,
no file, no log, under a title that blamed the team's code. These tests pin
the repair. The sandbox now reports the exception's class and where it was
raised; every lane decides a timeout the same way; no failed run's log file is
downloaded; and none of that text can change the category or the
infrastructure flag.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import textwrap
import time
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
from test_failure_attribution import LAST_ERROR_LINE, SCRIPT  # noqa: E402
from test_prepared_restore import Reporter, Store, Stream, functions, job  # noqa: E402

LANES = ("_evaluate", "_evaluate_v2", "_evaluate_week3", "_evaluate_week1")


def _units(text: str) -> int:
    return sum(2 if ord(character) > 0xFFFF else 1 for character in text)


def _run_team(team_code: str, raiser: str = "") -> str:
    """Run the real sandbox script against a repository holding `team_code`.

    `raiser` is extra source for the stubbed cogbench, so a test can make the
    exception come from benchmark code the team's function called, as B-44's
    did. Returns stderr.
    """

    with tempfile.TemporaryDirectory() as directory:
        tmp = Path(directory)
        package = tmp / "cogbench"
        package.mkdir()
        (package / "__init__.py").write_text("", encoding="utf-8")
        (package / "plugins.py").write_text(textwrap.dedent("""
            def load_benchmark(name):
                raise AssertionError("should not be reached")

            def load_submission(name, group=None, repo_root=None):
                import team_code
                return team_code.predict
        """) + textwrap.dedent(raiser), encoding="utf-8")
        repo = tmp / "repo"
        repo.mkdir()
        (repo / "team_code.py").write_text(textwrap.dedent(team_code), encoding="utf-8")
        (tmp / "project-root.txt").write_text(str(repo), encoding="utf-8")
        (tmp / "cog-inputs.json").write_text("[1, 2, 3]", encoding="utf-8")
        script = tmp / "evaluate.py"
        script.write_text(SCRIPT.replace("/tmp/", str(tmp) + "/"), encoding="utf-8")
        process = subprocess.run(
            [sys.executable, str(script), "language-search", "8192"],
            capture_output=True, text=True, cwd=str(tmp),
            env={"PYTHONPATH": str(tmp), "PATH": "/usr/bin:/bin"}, timeout=120,
        )
        return process.stderr


def _record(stderr: str) -> dict:
    last = stderr.strip().splitlines()[-1]
    assert last.startswith("COG_ERROR: "), stderr
    return json.loads(last[len("COG_ERROR: "):])


class TheSandboxSaysWhatRaisedAndWhere(unittest.TestCase):
    def test_an_exception_in_team_code_names_its_class_file_and_function(self):
        stderr = _run_team("""
            def predict(inputs):
                print("predicting {} inputs".format(len(inputs)))
                return lookup(inputs)

            def lookup(inputs):
                return inputs[0]["x"]
        """)
        record = _record(stderr)
        self.assertEqual(record["type"], "TypeError")
        self.assertIn("not subscriptable", record["message"])
        self.assertEqual(record["where"], ["team_code.py:7, in lookup"])

    def test_an_exception_in_benchmark_code_names_it_and_the_team_line_that_called_it(self):
        """B-44's shape: the line that raised was not the team's."""

        stderr = _run_team("""
            def predict(inputs):
                from cogbench.plugins import replay
                return replay(None)
        """, raiser="""
            def replay(row):
                return row[0]
        """)
        record = _record(stderr)
        self.assertEqual(record["where"][0], "plugins.py:10, in replay")
        self.assertEqual(record["where"][1], "team_code.py:4, in predict")

    def test_unencodable_output_does_not_lose_the_exception(self):
        """A lone surrogate the team printed still leaves the record last."""

        stderr = _run_team("""
            def predict(inputs):
                print("\\ud800")
                raise ValueError("bad shape")
        """)
        self.assertEqual(_record(stderr)["type"], "ValueError")

    def test_the_harness_own_frames_are_never_named(self):
        """A check the script itself raises has nowhere useful to point."""

        stderr = _run_team("""
            def predict(inputs):
                return [1]
        """)
        record = _record(stderr)
        self.assertIn("wrong number of predictions", record["message"])
        self.assertEqual(record["where"], [])


class TheControllerFormatsTheRecord(unittest.TestCase):
    def marked(self, **record) -> str:
        return "noise\nCOG_ERROR: {}\n".format(json.dumps(record))

    def test_class_message_and_both_places(self):
        detail = LAST_ERROR_LINE(self.marked(
            type="TypeError", message="'NoneType' object is not subscriptable",
            where=["cogbench/pipeline.py:834, in replay", "face.py:12, in describe"],
        ))
        self.assertEqual(detail, "TypeError: 'NoneType' object is not subscriptable\n"
                                 "at cogbench/pipeline.py:834, in replay\n"
                                 "called from face.py:12, in describe")

    def test_a_long_message_is_cut_before_the_place_is(self):
        detail = LAST_ERROR_LINE(self.marked(
            type="ValueError", message="word " * 120 + "\U0001f600" * 40,
            where=["model.py:88, in describe"],
        ))
        self.assertLessEqual(_units(detail), 240)
        self.assertTrue(detail.endswith("\nat model.py:88, in describe"))
        self.assertIn(" ...\n", detail)

    def test_a_record_without_a_place_is_just_the_exception(self):
        detail = LAST_ERROR_LINE(self.marked(type="KeyError", message="'overall'", where=[]))
        self.assertEqual(detail, "KeyError: 'overall'")

    def test_a_marker_line_that_is_not_a_record_is_shown_as_written(self):
        """Student code shares the pipe and can print any last line."""

        self.assertEqual(LAST_ERROR_LINE("COG_ERROR: {not json\n"), "{not json")
        self.assertEqual(LAST_ERROR_LINE('COG_ERROR: ["a list"]\n'), '["a list"]')


class _Sandbox:
    """A sandbox whose evaluation exited with `returncode`, reporting a log
    file of `log_bytes` bytes without holding one. Every filesystem read is
    recorded in `reads` and refused, so a test can show the failure path
    never downloads it."""

    def __init__(self, returncode: int, stderr: str, log_bytes: int = 0):
        self.returncode, self.stderr = returncode, stderr
        self.reads = []

        def read(name):
            def recorded(path, *args):
                self.reads.append((name, path))
                if name == "stat":
                    return types.SimpleNamespace(is_file=lambda: True, size=log_bytes)
                raise AssertionError("downloaded {}".format(path))
            return recorded

        self.filesystem = types.SimpleNamespace(
            write_text=lambda *args: None, write_bytes=lambda *args: None,
            **{name: read(name) for name in ("stat", "read_bytes", "read_text", "copy_to_local")},
        )

    def exec(self, *args, text=True):
        return types.SimpleNamespace(returncode=self.returncode, wait=lambda: None,
                                     stderr=Stream(self.stderr, text))

    def terminate(self):
        pass


def _lane(lane: str, sandbox: _Sandbox, elapsed: float = 1.0, mode: str = "practice"):
    """Run one lane's failure path; `elapsed` is what the controller's clock saw."""

    encoders = (
        mock.patch("cogworks_runner.week1_payload.encode_payload", return_value=b""),
        mock.patch("cogworks_runner.week2_payload.encode_cases", return_value=(b"", [])),
        mock.patch("cogworks_runner.week3_payload.encode_payload", return_value=b""),
    )
    readings = iter([0.0])
    clock = types.SimpleNamespace(time=lambda: next(readings, elapsed))
    space = functions(
        lane, "_evaluation_failure", "_last_error_line", "_timed_out", "_fit",
        "_take_units", "_receiver_units", app=object(), EVALUATE_SCRIPT="script",
        WEEK1_STUDENT_PYTHON="python", WEEK3_STUDENT_PYTHON="python", time=clock,
        modal=types.SimpleNamespace(Image=types.SimpleNamespace(from_id=lambda value: object()),
                                    Sandbox=types.SimpleNamespace(create=lambda **kwargs: sandbox)),
    )
    value = job()
    value["mode"] = mode
    with encoders[0], encoders[1], encoders[2]:
        try:
            space[lane](value, "im-saved", [])
        except space["RunnerFailure"] as failure:
            return failure
    raise AssertionError("{} did not fail".format(lane))


class EveryLaneDecidesTheSameWay(unittest.TestCase):
    def test_a_process_stopped_at_the_budget_is_a_timeout_in_every_lane(self):
        """B-11: the Week 2 lane never checked, so a kill read as an exception.

        Modal reports its own timeout as return code -1 at the budget.
        """

        for lane in LANES:
            with self.subTest(lane=lane):
                failure = _lane(lane, _Sandbox(-1, ""), elapsed=900)
                self.assertEqual((failure.category, failure.infrastructure), ("timeout", False))
                self.assertIn("900 second budget", str(failure))

    def test_only_week_1_gives_song_advice(self):
        """B-25: Week 3 used to tell a language team about songs."""

        for lane in LANES:
            with self.subTest(lane=lane):
                said = str(_lane(lane, _Sandbox(-1, ""), elapsed=900))
                self.assertEqual("song" in said, lane == "_evaluate_week1", said)

    def test_an_exception_carries_its_detail_and_stays_out_of_infrastructure(self):
        stderr = 'COG_ERROR: {"type": "TypeError", "message": "bad", "where": ["m.py:3, in f"]}\n'
        for lane in LANES:
            with self.subTest(lane=lane):
                failure = _lane(lane, _Sandbox(2, stderr))
                self.assertEqual((failure.category, failure.infrastructure), ("student_runtime", False))
                self.assertEqual(str(failure), "TypeError: bad\nat m.py:3, in f")

    def test_exiting_with_a_kill_code_is_not_a_timeout(self):
        """`os._exit(137)` is one line of student code; only the clock decides."""

        for lane in LANES:
            for code in (-9, 137, -15, 143):
                with self.subTest(lane=lane, code=code):
                    self.assertEqual(_lane(lane, _Sandbox(code, "")).category, "student_runtime")

    def test_printing_killed_is_not_a_timeout(self):
        """The word was a third timeout signal, read from text the team writes."""

        said = 'Killed\nCOG_ERROR: {"type": "RuntimeError", "message": "killed", "where": []}\n'
        for lane in LANES:
            with self.subTest(lane=lane):
                failure = _lane(lane, _Sandbox(2, said))
                self.assertEqual(failure.category, "student_runtime")

    def test_a_malformed_record_stays_the_evaluation_failure(self):
        """A record that raised while being formatted became a provider fault."""

        nested = "[" * 1200 + "]" * 1200
        for record in ('{"where": 17}', '{"where": [1, null, {"a": 1}], "type": 3}', '[]', '"text"', nested):
            with self.subTest(record=record[:40]):
                failure = _lane("_evaluate_v2", _Sandbox(2, "COG_ERROR: {}\n".format(record)))
                self.assertEqual((failure.category, failure.infrastructure), ("student_runtime", False))
                self.assertLessEqual(_units(str(failure)), 240)

    def test_a_marker_claiming_infrastructure_changes_nothing(self):
        forged = 'COG_ERROR: {"type": "ProviderError", "infrastructure": true, "category": "provider"}\n'
        failure = _lane("_evaluate_v2", _Sandbox(2, forged))
        self.assertEqual((failure.category, failure.infrastructure), ("student_runtime", False))


class NoLogIsDownloadedForAFailure(unittest.TestCase):
    """The log file is the submission's to replace, and Modal's supported
    filesystem API only transfers whole files, so a failed evaluation reads
    none of it. The failure keeps its reason from the stderr record."""

    RAISED = 'COG_ERROR: {"type": "TypeError", "message": "bad", "where": ["m.py:3, in f"]}\n'

    def test_no_lane_reads_the_sandbox_filesystem_on_failure(self):
        for lane in LANES:
            for mode in ("practice", "official"):
                for log_bytes in (64, 512 * 1024 * 1024):
                    with self.subTest(lane=lane, mode=mode, log_bytes=log_bytes):
                        sandbox = _Sandbox(2, self.RAISED, log_bytes)
                        failure = _lane(lane, sandbox, mode=mode)
                        self.assertEqual(sandbox.reads, [])
                        self.assertEqual((failure.category, failure.infrastructure), ("student_runtime", False))
                        self.assertEqual(str(failure), "TypeError: bad\nat m.py:3, in f")

    def test_a_timeout_reads_nothing_either(self):
        sandbox = _Sandbox(-1, "", 512 * 1024 * 1024)
        failure = _lane("_evaluate_v2", sandbox, elapsed=900)
        self.assertEqual(failure.category, "timeout")
        self.assertEqual(sandbox.reads, [])

    def test_the_failed_event_carries_the_reason_and_no_log(self):
        events = []

        def prepare(job, reporter):
            raise space["RunnerFailure"]("student_runtime", "evaluating", "TypeError: bad", False)

        space = functions(
            "execute_job", "_failure_detail", "_fit", "_take_units", "_receiver_units", "_wire_log",
            job_store=Store(), validate_job=lambda value: value,
            _outcome_key=lambda key: key + ":outcome", LiveReporter=Reporter,
            _prepare=prepare,
            _finish=lambda job, outcome, status: events.append(outcome["event"]),
            _WIRING=[],
        )
        space["execute_job"](job())
        self.assertEqual(events[0]["failure"]["detail"], "TypeError: bad")
        self.assertNotIn("sanitizedLog", events[0])


class TheCompletedLogFitsTheWire(unittest.TestCase):
    def test_it_fits_the_receiver_cap_in_utf16_units_and_keeps_its_end(self):
        """Over the cap the portal answers 400 and the whole event is lost."""

        wire_log = functions("_wire_log", "_take_units", "_receiver_units")["_wire_log"]
        log = "\U0001f600" * 8192 + "showcase: done\n"
        sent = wire_log(job(), log)
        self.assertLessEqual(_units(sent), 8 * 1024)
        self.assertTrue(sent.endswith("showcase: done\n"))
        self.assertIn("[log shortened to fit]", sent)
        official = job()
        official["mode"] = "official"
        self.assertIsNone(wire_log(official, "printed\n"))


if __name__ == "__main__":
    unittest.main()
