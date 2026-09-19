import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))

from cogworks_runner.protocol import canonical_json, signature, validate_job, verify_signature


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.job = json.loads(
            (ROOT / "protocols" / "v1" / "fixtures" / "run-job.valid.json").read_text(
                encoding="utf-8"
            )
        )

    def test_valid_job_matches_golden_fixture(self):
        self.assertEqual(validate_job(self.job)["protocolVersion"], "1")

    def test_official_requires_prepared_artifact(self):
        self.job["mode"] = "official"
        with self.assertRaises(ValueError):
            validate_job(self.job)

    def test_prepared_job_may_omit_weights(self):
        self.job["mode"] = "official"
        self.job["preparedArtifactId"] = "snapshot_1"
        self.job.pop("weights")
        self.assertEqual(validate_job(self.job)["preparedArtifactId"], "snapshot_1")

    def test_weight_digest_must_be_lowercase_sha256(self):
        self.job["weights"][0]["sha256"] = "G" * 64
        with self.assertRaisesRegex(ValueError, "digest"):
            validate_job(self.job)

    def test_weight_manifest_is_limited_to_eight_entries(self):
        self.job["weights"] = [
            {
                "path": "models/{}.pkl".format(index),
                "size": 1,
                "sha256": "a" * 64,
            }
            for index in range(9)
        ]
        with self.assertRaisesRegex(ValueError, "at most 8"):
            validate_job(self.job)

    def test_hmac_rejects_replay_and_accepts_current_message(self):
        body = canonical_json(self.job)
        supplied = "v1=" + signature("secret", "1000", body)
        self.assertTrue(verify_signature("secret", "1000", body, supplied, now_seconds=1000))
        self.assertFalse(verify_signature("secret", "1000", body, supplied, now_seconds=1400))


if __name__ == "__main__":
    unittest.main()
