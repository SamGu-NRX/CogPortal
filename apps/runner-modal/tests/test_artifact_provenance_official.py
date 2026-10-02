"""An official run scores only the dataset bytes its signed job approved.

The 2026-10-02 provenance audit replaced gold under an unchanged dataset
version and measured overall 1.0 against 0.61 with identical run records.
These run the real controller functions, payload decoder, digest check, gold
attachment and scorer on synthetic cases, and require that replacement, a
missing approval, and a replacement between two reads are all refused before
evaluation. Only the hidden-volume root, sandbox execution and event delivery
are replaced. No Modal service or course data is used.
"""
from __future__ import annotations

import ast
import contextlib
import copy
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps/runner-modal/src"))
sys.path.insert(0, str(ROOT / "python/cogbench/src"))
sys.path.insert(0, str(Path(__file__).parent))

from test_prepared_restore import Reporter, functions, job
from test_prepared_environment import require_benchmark
from cogworks_runner.official_bundle import dataset_digest, read_bundle
from cogworks_runner.prepared_environment import bind_environment
from cogworks_runner.protocol import validate_job


class OfficialDatasetIdentity(unittest.TestCase):
    def setUp(self):
        require_benchmark("language-search")
        from language_search_benchmark.plugins import LanguageSearchBenchmark
        from test_week3_payload import _cases
        from cogworks_runner.week3_payload import encode_payload, extract_gold

        self.benchmark = LanguageSearchBenchmark()
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.hidden = Path(self.temporary.name)
        self.request = job()
        self.request["benchmark"].update(
            id=self.benchmark.benchmark_id,
            version=self.benchmark.benchmark_version,
            contractVersion=self.benchmark.contract_version,
            pluginVersion=self.benchmark.plugin_version,
            scorerVersion=self.benchmark.scorer_version,
            datasetVersion="synthetic-official-v1",
            sandboxContract=2,
        )
        # This is synthetic provisioning evidence, not a claim that the test
        # interpreter is a saved Python 3.8 Modal sandbox.
        observation = {
            "sandboxContract": 2, "pythonVersion": "3.8.20", "sdkVersion": "0.2.0",
            "modules": [{"name": "synthetic.module", "path": "/synthetic/module.py",
                         "sha256": "b" * 64}],
        }
        evidence = bind_environment(self.request, observation, "im-synthetic", "im-synthetic-base")
        self.request.update(mode="official", preparedArtifactId="im-synthetic", preparedEnvironment=evidence)
        del self.request["weights"]
        validate_job(self.request)
        self.bundle = self.hidden / self.benchmark.benchmark_id / self.request["benchmark"]["datasetVersion"]
        self.bundle.mkdir(parents=True)
        self.payload = encode_payload(self.benchmark.benchmark_id, _cases(), showcase=False)
        (self.bundle / "payload.zip").write_bytes(self.payload)
        self.gold = extract_gold(_cases())
        self.write_gold(self.gold)
        self.approve()

    def approve(self, request=None):
        """What the catalog does: record the digest of the bytes as they are now."""
        request = request or self.request
        request["benchmark"]["datasetDigest"] = dataset_digest(
            read_bundle(self.bundle, self.benchmark.benchmark_id)
        )
        validate_job(request)
        return request["benchmark"]["datasetDigest"]

    def write_gold(self, gold):
        (self.bundle / "gold.json").write_text(json.dumps(gold), encoding="utf-8")

    def execute(self, request=None):
        completed = []
        evaluated = []

        def fixed_predictions(request, snapshot, cases):
            retrieval = next(case for case in cases if case.kind == "retrieval")
            evaluated.append({"artifact": snapshot, "descriptors": retrieval.descriptors.tolist(),
                              "gold_rows": retrieval.gold_rows})
            # A deterministic submission response independent of controller gold.
            outputs = []
            for case in cases:
                if case.kind == "text":
                    outputs.append({"ok": True, "embeddings": [[1, 0], [1, 0], [0, 1]]})
                elif case.kind == "retrieval":
                    outputs.append({"ok": True, "text": [[1, 0], [0, 1]],
                                    "images": [[1, 0], [-1, -1], [0, 1]]})
                else:
                    outputs.append({"ok": True, "rankings": [[10, 20, 30], [30, 20, 10]]})
            return outputs, ""

        # Load EVALUATE_SCRIPT from the production assignment without importing
        # Modal's module-level image definitions or contacting the provider.
        tree = ast.parse((ROOT / "apps/runner-modal/src/cogworks_runner/modal_app.py").read_text())
        script = next(ast.literal_eval(node.value) for node in tree.body
                      if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id == "EVALUATE_SCRIPT"
                              for target in node.targets))
        space = functions(
            "_run_claimed", "_load_benchmark", "_week3_cases", "_v2_metrics",
            "_primary_for_run", "_sweep_wire", "_failure_detail", "_fit",
            "_take_units", "_receiver_units", "_wire_log", "_diagnostic_lines",
            Path=lambda value: self.hidden if value == "/hidden" else Path(value),
            _evaluate_week3=fixed_predictions,
            _prepare=mock.Mock(side_effect=AssertionError("official must reuse its saved artifact")),
            _finish=lambda request, outcome, status: completed.append(outcome["event"]),
            StatusHeartbeat=lambda *args: contextlib.nullcontext(),
            EVALUATE_SCRIPT=script, _WIRING=[],
        )
        with mock.patch("cogbench.plugins.load_benchmark", return_value=self.benchmark):
            request = copy.deepcopy(request or self.request)
            space["_run_claimed"](request, Reporter(request))
        self.assertEqual(len(completed), 1)
        return completed[0], evaluated

    def assertRefusedBeforeEvaluation(self, result, evaluated):
        self.assertEqual(evaluated, [])
        self.assertEqual(result["type"], "failed", result)
        self.assertEqual(result["failure"]["category"], "data_download")
        self.assertTrue(result["failure"]["infrastructure"])
        self.assertEqual(
            result["failure"]["detail"],
            "Official Week 3 data is missing or failed integrity validation.",
        )

    def test_gold_replaced_under_the_same_version_is_refused(self):
        first, _ = self.execute()
        self.assertEqual(first["type"], "completed", first)
        replacement = copy.deepcopy(self.gold)
        replacement["retrieval_gold_rows"] = [2, 0]
        replacement["search_gold_image_ids"] = [30, 10]
        self.write_gold(replacement)
        # Retry is a new admitted execution carrying the digest it was frozen
        # with; it must not score the replaced answers (the audit's 0.61).
        retry = copy.deepcopy(self.request)
        retry.update(jobId="job_retry", runId="run_retry")
        with contextlib.redirect_stderr(io.StringIO()) as log:
            second, evaluated = self.execute(retry)
        self.assertRefusedBeforeEvaluation(second, evaluated)
        self.assertIn("do not match the approved digest", log.getvalue())

    def test_an_official_job_without_an_approved_digest_is_refused(self):
        # A job frozen before digests existed: refuse rather than guess.
        request = copy.deepcopy(self.request)
        del request["benchmark"]["datasetDigest"]
        validate_job(request)
        with contextlib.redirect_stderr(io.StringIO()) as log:
            result, evaluated = self.execute(request)
        self.assertRefusedBeforeEvaluation(result, evaluated)
        self.assertIn("carries no approved dataset digest", log.getvalue())

    def test_a_missing_scored_file_is_refused(self):
        (self.bundle / "gold.json").unlink()
        result, evaluated = self.execute()
        self.assertRefusedBeforeEvaluation(result, evaluated)

    def test_a_stray_file_beside_the_bundle_changes_nothing(self):
        first, _ = self.execute()
        (self.bundle / "README.txt").write_text("notes", encoding="utf-8")
        second, _ = self.execute()
        self.assertEqual(second["type"], "completed", second)
        self.assertEqual(first["environmentDigest"], second["environmentDigest"])
        self.assertEqual(first["result"]["metrics"], second["result"]["metrics"])

    def test_the_verified_digest_is_part_of_the_recorded_identity(self):
        first, _ = self.execute()
        replacement = copy.deepcopy(self.gold)
        replacement["retrieval_gold_rows"] = [2, 0]
        replacement["search_gold_image_ids"] = [30, 10]
        self.write_gold(replacement)
        # Approved as a different dataset: it scores, and the record says so.
        other = copy.deepcopy(self.request)
        other.update(jobId="job_other", runId="run_other")
        self.approve(other)
        second, _ = self.execute(other)
        self.assertEqual(second["type"], "completed", second)
        self.assertEqual(first["preparedEnvironment"], second["preparedEnvironment"])
        self.assertNotEqual(first["environmentDigest"], second["environmentDigest"])
        metrics = [{metric["key"]: metric["value"] for metric in event["result"]["metrics"]}
                   for event in (first, second)]
        self.assertEqual([metric["retrieval_mrr"] for metric in metrics], [1.0, 0.5])

    def test_a_replacement_between_reads_is_refused_not_mixed(self):
        """Payload A and gold B never score together, even locally.

        The controller reads every scored file once and hashes those bytes, so
        a directory swapped after the payload read fails the digest. Not a
        hosted race claim: Modal mounts keep their state until a reload.
        """
        from test_week3_payload import _cases
        from cogworks_runner.week3_payload import encode_payload, extract_gold

        changed = _cases()
        changed[1].descriptors[:] = changed[1].descriptors[::-1].copy()
        changed[2].descriptors[:] = changed[2].descriptors[::-1].copy()
        changed[1].gold_rows[:] = [2, 0]
        changed[2].gold_image_ids[:] = [30, 10]
        replacement = self.bundle.parent / "replacement"
        replacement.mkdir()
        (replacement / "payload.zip").write_bytes(encode_payload(self.benchmark.benchmark_id, changed, showcase=False))
        (replacement / "gold.json").write_text(json.dumps(extract_gold(changed)), encoding="utf-8")
        read_bytes = Path.read_bytes
        replaced = []

        def replace_after_payload_read(path):
            value = read_bytes(path)
            if path == self.bundle / "payload.zip" and not replaced:
                # Both directories belong to this test's TemporaryDirectory.
                shutil.rmtree(self.bundle)
                os.replace(replacement, self.bundle)
                replaced.append(True)
            return value

        request = copy.deepcopy(self.request)
        request.update(jobId="job_during_replacement", runId="run_during_replacement")
        with mock.patch.object(Path, "read_bytes", replace_after_payload_read):
            result, evaluated = self.execute(request)
        self.assertEqual(replaced, [True])
        self.assertRefusedBeforeEvaluation(result, evaluated)

    def test_malformed_gold_is_refused_before_evaluation(self):
        malformed = copy.deepcopy(self.gold)
        malformed["retrieval_gold_rows"] = [0]
        self.write_gold(malformed)
        # Approved as it is, so the refusal is the decoder's, not the digest's.
        self.approve()
        result, evaluated = self.execute()
        self.assertEqual(evaluated, [])
        self.assertEqual(result["type"], "failed")
        self.assertEqual(result["failure"]["category"], "data_download")

    def test_wrong_saved_artifact_or_contract_is_refused_before_evaluation(self):
        for field, value in (("artifactId", "im-other"), ("sandboxContract", 1)):
            with self.subTest(field=field):
                request = copy.deepcopy(self.request)
                request["preparedEnvironment"][field] = value
                result, evaluated = self.execute(request)
                self.assertEqual(evaluated, [])
                self.assertEqual(result["type"], "failed")
                self.assertEqual(result["failure"]["phase"], "contract_check")

    def test_wrong_benchmark_or_scorer_metadata_is_refused_before_evaluation(self):
        for field, value in (("version", 999), ("pluginVersion", "wrong"),
                             ("scorerVersion", "wrong"), ("contractVersion", "wrong")):
            with self.subTest(field=field):
                request = copy.deepcopy(self.request)
                request["benchmark"][field] = value
                result, evaluated = self.execute(request)
                self.assertEqual(evaluated, [])
                self.assertEqual(result["type"], "failed")
                self.assertEqual(result["failure"]["phase"], "contract_check")
                self.assertEqual(result["failure"]["detail"], "Trusted benchmark plugin version does not match the run job.")


class LegacyContract(unittest.TestCase):
    """The v1 loader has no approved layout, so official runs never reach it."""

    def test_an_official_v1_run_is_refused_and_practice_still_loads(self):
        from cogworks_runner.failure import RunnerFailure

        loader = functions("_cases")["_cases"]
        public = mock.Mock()
        public.public_cases.return_value = [{"input": [1], "expected": 0}]
        request = job()
        for digest in (None, "a" * 64):
            with self.subTest(digest=digest):
                official = copy.deepcopy(request)
                official.update(mode="official", preparedArtifactId="im-saved")
                official["benchmark"]["datasetDigest"] = digest
                with contextlib.redirect_stderr(io.StringIO()), \
                        self.assertRaises(RunnerFailure) as caught:
                    loader(official, public)
                self.assertEqual(
                    (caught.exception.category, caught.exception.infrastructure),
                    ("data_download", True),
                )
        public.public_cases.assert_not_called()
        practice = copy.deepcopy(request)
        practice["mode"] = "practice"
        self.assertEqual(loader(practice, public), ([[1]], [0]))


if __name__ == "__main__":
    unittest.main()
