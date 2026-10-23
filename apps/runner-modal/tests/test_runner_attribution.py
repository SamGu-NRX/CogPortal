from __future__ import annotations

import ast
import contextlib
import io
import json
import sys
import threading
import time
import types
import unittest
from pathlib import Path

from test_prepared_restore import SOURCE, Reporter, job, shape_valid_observation


class Process:
    def __init__(self, returncode, stdout=b"", stderr=b""):
        self.returncode = returncode
        self.stdout = io.StringIO(stdout.decode("utf-8"))
        self.stderr = io.BytesIO(stderr)

    def wait(self):
        return None


def prepare_function(**globals_):
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_prepare")
    node.decorator_list = []
    namespace = {
        "Dict": dict,
        "Any": object,
        "Tuple": tuple,
        "List": list,
        "Optional": object,
        "time": time,
        "os": types.SimpleNamespace(environ={"RUNNER_SIGNING_SECRET": "test"}),
        "sys": sys,
        "json": json,
        "urlsplit": __import__("urllib.parse", fromlist=["urlsplit"]).urlsplit,
        "quote": __import__("urllib.parse", fromlist=["quote"]).quote,
        "signature": lambda *args: "signature",
        "RunnerFailure": __import__("cogworks_runner.failure", fromlist=["RunnerFailure"]).RunnerFailure,
        "bind_environment": lambda job, observation, snapshot_id, base_image_id: {
            "artifactId": snapshot_id,
            "baseImageId": base_image_id,
            **observation,
        },
        "StatusHeartbeat": lambda *args: contextlib.nullcontext(),
        "PREPARE_SCRIPT": "prepare",
        "_terminate_sandbox": lambda sandbox, phase: None,
        **globals_,
    }
    exec(compile(ast.Module([node], []), str(SOURCE), "exec"), namespace)
    return namespace["_prepare"], namespace


class FakeSandbox:
    class Files:
        def write_text(self, *_args):
            return None

    def __init__(self, processes):
        self.filesystem = self.Files()
        self.processes = iter(processes)
        self.object_id = "image-id"

    def exec(self, *_args, **_kwargs):
        return next(self.processes)

    def snapshot_filesystem(self):
        return types.SimpleNamespace(object_id="snapshot-id")


class RunnerAttributionTests(unittest.TestCase):
    def base_globals(self, processes, timed_out):
        sandbox = FakeSandbox(processes)
        image = types.SimpleNamespace(object_id="image-id")
        modal = types.SimpleNamespace(
            Sandbox=types.SimpleNamespace(create=lambda **_kwargs: sandbox)
        )
        return {
            "modal": modal,
            "app": object(),
            "_sandbox_image": lambda _job: image,
            "_student_python": lambda _job: "python",
            "validate_observation": lambda _job, _observation: None,
            "_timed_out": lambda _job, _started: timed_out,
        }

    def test_pristine_probe_timeout_is_preparing_timeout(self):
        prepare, globals_ = prepare_function(
            **self.base_globals(
                [Process(1, stderr=b"killed")],
                timed_out=True,
            )
        )

        with self.assertRaises(globals_["RunnerFailure"]) as raised:
            prepare(job(), Reporter(job()))

        self.assertEqual(raised.exception.category, "timeout")
        self.assertEqual(raised.exception.phase, "preparing")

    def test_install_timeout_is_installing_timeout(self):
        prepare, globals_ = prepare_function(
            **self.base_globals(
                [
                    Process(0, stdout=json.dumps(shape_valid_observation()).encode()),
                    Process(1, stderr=b"killed"),
                ],
                timed_out=True,
            )
        )

        with self.assertRaises(globals_["RunnerFailure"]) as raised:
            prepare(job(), Reporter(job()))

        self.assertEqual(raised.exception.category, "timeout")
        self.assertEqual(raised.exception.phase, "installing")

    def test_terminal_failure_flushes_in_flight_progress(self):
        tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
        nodes = [
            n for n in tree.body
            if isinstance(n, (ast.FunctionDef, ast.ClassDef))
            and n.name in {"_event", "LiveReporter"}
        ]
        for node in nodes:
            node.decorator_list = []
        started = threading.Event()
        release = threading.Event()
        events = []

        def post(_job, event):
            if event["type"] == "status":
                started.set()
                release.wait(5)
            events.append(event)

        namespace = {
            "threading": threading,
            "time": time,
            "Any": object,
            "Dict": dict,
            "_event": lambda job, sequence, event_type, **fields: {
                "runId": job["runId"], "sequence": sequence, "type": event_type, **fields
            },
            "_post_event": post,
        }
        exec(compile(ast.Module(nodes, []), str(SOURCE), "exec"), namespace)
        reporter = namespace["LiveReporter"]({"runId": "run", "jobId": "job"})

        status = threading.Thread(target=reporter.status, args=("installing",))
        status.start()
        self.assertTrue(started.wait(5))
        terminal = []

        def build():
            terminal.append(reporter.build("failed", flush=True, failure={}))

        failure = threading.Thread(target=build)
        failure.start()
        time.sleep(0.05)
        self.assertTrue(failure.is_alive())
        release.set()
        status.join(5)
        failure.join(5)

        self.assertEqual([event["type"] for event in events], ["status"])
        self.assertEqual(terminal[0]["sequence"], 1)


if __name__ == "__main__":
    unittest.main()
