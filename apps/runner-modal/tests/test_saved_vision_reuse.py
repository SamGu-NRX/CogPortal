"""Local saved-artifact reuse through current scoring, with provider I/O substituted.

The preserved decoder and driver execute in process, not in a hosted snapshot.
Only the corpus and provider interfaces are synthetic; scoring uses the installed
benchmark. PR8 alone skips until the recognition-v2 query allocation is present.
"""
from __future__ import annotations

import ast
import contextlib
import copy
import hashlib
import io
import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import test_prepared_restore as prepared_restore
from test_prepared_restore import SOURCE, functions, job
from test_saved_contract_pairs import FIXTURES, saved
from test_prepared_environment import require_benchmark
from cogworks_runner.prepared_environment import bind_environment, probe
from cogworks_runner.protocol import canonical_json, validate_job


def controller_space(base):
    """Load controller functions and their constants without importing Modal."""
    names = {
        "EVALUATE_SCRIPT", "_SAFE_INT", "_TYPE_WORDS", "_V2_PREDICTION_SHAPES",
        "_NULLABLE_PREDICTION_FIELDS", "_NUMERIC_MATRIX_FIELDS", "_EMPTY_ROW_OK",
        "_RECOGNITION_BATCHES",
    }
    constants = []
    found = set()
    for node in ast.parse(SOURCE.read_text()).body:
        targets = node.targets if isinstance(node, ast.Assign) else (
            [node.target] if isinstance(node, ast.AnnAssign) else []
        )
        matched = {target.id for target in targets if isinstance(target, ast.Name)} & names
        if matched:
            constants.append(node)
            found.update(matched)
    assert found == names, "Controller constant extraction is incomplete"
    space = functions(
        "RunnerFailure", "execute_job", "_load_benchmark", "_evaluate_v2",
        "_restore_v2_predictions", "_load_predictions", "_NonFiniteNumber",
        "_reject_constant", "_finite_float", "_bounded_int", "_type_word",
        "_refuse_output", "_check_predictions", "_check_matrix_field",
        "_collect_wiring", "_last_error_line", "_v2_metrics", "_primary_for_run",
        "_sweep_wire", "_diagnostic_lines", **base,
    )
    exec(compile(ast.Module(constants, []), str(SOURCE), "exec"), space)
    space["validate_job"] = validate_job
    return space


class SavedVisionReuse(unittest.TestCase):
    def test_reuse_preserves_provisioning_and_scores_old_driver_with_current_encoder(self):
        require_benchmark("vision-recognition")
        import numpy as np
        from facial_recognition_benchmark import drivers
        if not hasattr(drivers, "query_phases"):
            self.skipTest("Recognition-v2 allocation is supplied by PR19 at integration")

        old_payload = saved("saved_reuse_vision_payload", "pr8_week2_payload.py")
        old_driver = saved("facial_recognition_benchmark.saved_reuse_drivers", "c177_vision_drivers.py")
        self.assertEqual(Path(old_payload.__file__), FIXTURES / "pr8_week2_payload.py")
        self.assertEqual(Path(old_driver.__file__), FIXTURES / "c177_vision_drivers.py")

        # Observe the actual preserved source files before either adapter runs.
        # This is local provenance, not a claim about a provider's filesystem.
        original_job = job()
        # The helper's placeholder plugin version cannot pass _load_benchmark.
        original_job["benchmark"]["pluginVersion"] = "0.1.0"
        original_job["weights"] = [{
            "path": "model/weights.npz", "size": 12, "sha256": "b" * 64,
        }]
        with mock.patch.dict(sys.modules, {
            "cogworks_runner.week2_payload": old_payload,
            "facial_recognition_benchmark.drivers": old_driver,
        }):
            observation = probe("vision-recognition")
        evidence = bind_environment(original_job, observation, "im-saved", "im-original-base")
        original_evidence = copy.deepcopy(evidence)
        original_bytes = canonical_json(evidence)
        for module in (old_payload, old_driver):
            record = next(row for row in evidence["modules"] if row["path"] == module.__file__)
            self.assertEqual(record["sha256"], hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest())

        image = lambda value: np.full((2, 2, 3), value, dtype=np.uint8)
        case = drivers.RecognitionScenario(
            known=[drivers.RecognitionIdentity("alice", [image(1)], [image(1)] * 4),
                   drivers.RecognitionIdentity("bob", [image(2)], [image(2)] * 4)],
            unknown_person_id="stranger", unknown_queries=[image(3)] * 2,
            unknown_enrollment=[image(3)], post_enrollment_queries=[image(3)] * 2,
        )

        class Retaining:
            def __init__(self, model):
                self.known = {}

            def enroll(self, person_id, images):
                for item in images:
                    self.known[int(item[0, 0, 0])] = person_id

            def recognize(self, images):
                return [self.known.get(int(item[0, 0, 0])) for item in images]

        class Forgetting(Retaining):
            def enroll(self, person_id, images):
                if person_id == "stranger":
                    self.known.clear()
                super().enroll(person_id, images)

        results = []
        for adapter in (Retaining, Forgetting):
            with self.subTest(adapter=adapter.__name__):
                base, events = prepared_restore.PreparedRestore().execute_space()
                space = controller_space(base)
                value = copy.deepcopy(original_job)
                value.update(mode="official", preparedArtifactId="im-saved",
                             preparedEnvironment=evidence, weights=[])
                value["benchmark"]["scorerVersion"] = "recognition-v2"
                value["runtime"]["imageDigest"] = "different-current-image"
                calls = []
                files = {}
                test = self

                class Files:
                    def write_bytes(self, data, path):
                        test.assertEqual(path, "/tmp/cog-v2-payload.zip")
                        files[path] = data

                    def write_text(self, text, path):
                        test.assertEqual(path, "/tmp/cog-evaluate.py", "Reuse must not install or prepare")
                        test.assertEqual(text, space["EVALUATE_SCRIPT"])
                        files[path] = text

                    def read_text(self, path):
                        return files[path]

                class Sandbox:
                    filesystem = Files()

                    def exec(self, *args):
                        test.assertEqual(args, ("python", "/tmp/cog-evaluate.py",
                                                "vision-recognition", "8192"),
                                         "Reuse must execute evaluation only, never install")
                        calls.append("evaluate")
                        benchmark_id, decoded = old_payload.decode_cases(files["/tmp/cog-v2-payload.zip"])
                        test.assertEqual(benchmark_id, "vision-recognition")
                        test.assertEqual(len(decoded), 1)
                        predictions = [old_driver.run_recognition_scenario(adapter, object(), decoded[0])]
                        files["/tmp/cog-predictions.json"] = json.dumps(predictions)
                        files["/tmp/cog-student.log"] = ""
                        return types.SimpleNamespace(returncode=0, wait=lambda: None,
                                                     stderr=io.StringIO(""))

                    def terminate(self):
                        calls.append("terminate")

                def from_id(snapshot_id):
                    test.assertEqual(snapshot_id, original_evidence["artifactId"])
                    calls.append("restore")
                    return snapshot_id

                def create(**kwargs):
                    test.assertEqual(kwargs["image"], original_evidence["artifactId"])
                    test.assertTrue(kwargs["block_network"])
                    return Sandbox()

                space.update(
                    modal=types.SimpleNamespace(
                        Image=types.SimpleNamespace(from_id=from_id),
                        Sandbox=types.SimpleNamespace(create=create),
                    ),
                    app=object(), _v2_cases=lambda *_: [copy.deepcopy(case)],
                    StatusHeartbeat=lambda *_: contextlib.nullcontext(),
                )
                # The inherited _prepare fails loudly. Also forbid reconstructing
                # the evidence from today's interpreter or the reuse job's weights.
                with mock.patch.dict(space, {
                    "bind_environment": mock.Mock(side_effect=AssertionError("Reuse rebuilt provisioning")),
                }), mock.patch.dict(os.environ, {
                    "RUNNER_SIGNING_SECRET": "local-saved-vision-reuse-fixture",
                }):
                    space["execute_job"](value)
                self.assertEqual(len(events), 1)
                completed = events[0]
                self.assertEqual(completed["type"], "completed", completed)
                self.assertEqual(calls, ["restore", "evaluate", "terminate"])
                self.assertEqual(completed["preparedArtifactId"], "im-saved")
                self.assertEqual(completed["preparedEnvironment"], original_evidence)
                self.assertEqual(canonical_json(evidence), original_bytes)
                self.assertEqual(canonical_json(completed["preparedEnvironment"]), original_bytes)
                self.assertNotIn("weightsSupplied", completed["result"])
                metrics = {metric["key"]: metric["value"] for metric in completed["result"]["metrics"]}
                self.assertTrue(metrics, "The real scorer must emit metrics")
                self.assertEqual(completed["result"]["benchmarkId"], "vision-recognition")
                results.append(metrics)

        self.assertEqual(len(results), 2, "Both adapters must reach metric emission")
        self.assertEqual(results[0]["recognition_score"], 1.0)
        self.assertEqual(results[1]["known_identification"], 0.5)
        self.assertLess(results[1]["recognition_score"], results[0]["recognition_score"])


if __name__ == "__main__":
    unittest.main()
