"""Real preserved decoders, compared with the controller's current contracts.

Fixtures are unedited source from PR8 8871f88 and Vision benchmark c177cf2.
They are committed so shallow CI checkouts can exercise the historical code.
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = Path(__file__).parent / "fixtures/saved_environments"
sys.path.insert(0, str(ROOT / "apps/runner-modal/src"))
sys.path.insert(0, str(Path(__file__).parent))
from test_prepared_environment import require_benchmark


def saved(name, filename):
    spec = importlib.util.spec_from_file_location(name, FIXTURES / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class SavedContractPairs(unittest.TestCase):
    def test_language_contract_is_the_observed_case_grid(self):
        require_benchmark("language-search")
        from cogworks_runner.week3_payload import decode_payload, encode_payload
        from cogworks_runner.prepared_environment import SANDBOX_CONTRACTS
        from test_week3_payload import _cases
        old = saved("saved_language_payload", "pr8_week3_payload.py")
        payload = encode_payload("language-search", _cases(), showcase=False)
        _, _, old_cases = old.decode_payload(payload)
        _, _, current_cases = decode_payload(payload)
        self.assertEqual([(case.kind, getattr(case, "rung", "verbatim")) for case in old_cases], [
            ("text", "verbatim"), ("retrieval", "verbatim"), ("search", "verbatim"),
            ("search", "keywords"), ("search", "truncated"), ("search", "typo"),
        ])
        contract = SANDBOX_CONTRACTS["language-search"]
        self.assertEqual(len(current_cases), {1: 6, 2: 9}[contract],
                         "sandboxContract must describe the real decoder/grid pair")
        if contract == 2:
            self.assertNotEqual(len(old_cases), len(current_cases))

    def test_old_vision_driver_honors_current_shuffled_lifecycle(self):
        require_benchmark("vision-recognition")
        import numpy as np
        from cogworks_runner.week2_payload import encode_cases, restore_recognition_outputs
        from facial_recognition_benchmark import drivers
        from facial_recognition_benchmark.metrics import score_recognition
        if not hasattr(drivers, "query_phases"):
            self.skipTest("Recognition-v2 allocation is supplied by PR19 at integration")
        old_payload = saved("saved_vision_payload", "pr8_week2_payload.py")
        old_driver = saved("facial_recognition_benchmark.saved_drivers", "c177_vision_drivers.py")
        image = lambda value: np.full((2, 2, 3), value, dtype=np.uint8)
        case = drivers.RecognitionScenario(
            known=[drivers.RecognitionIdentity("alice", [image(1)], [image(1)] * 4),
                   drivers.RecognitionIdentity("bob", [image(2)], [image(2)] * 4)],
            unknown_person_id="stranger", unknown_queries=[image(3)] * 2,
            unknown_enrollment=[image(3)], post_enrollment_queries=[image(3)] * 2,
        )
        payload, plans = encode_cases("vision-recognition", [case], seed_key=b"saved-environment-fixture")
        _, decoded = old_payload.decode_cases(payload)

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

        metrics = []
        for adapter in (Retaining, Forgetting):
            predictions = old_driver.run_recognition_scenario(adapter, object(), decoded[0])
            restored = restore_recognition_outputs(plans[0], predictions)
            metrics.append(score_recognition([restored], [drivers.recognition_expected(case)]))
        self.assertEqual(metrics[0]["recognition_score"], 1.0)
        self.assertEqual(metrics[1]["known_identification"], 0.5)
        self.assertLess(metrics[1]["recognition_score"], metrics[0]["recognition_score"])
        self.assertEqual(Path(old_driver.__file__), FIXTURES / "c177_vision_drivers.py")
        self.assertEqual(Path(old_payload.__file__), FIXTURES / "pr8_week2_payload.py")


if __name__ == "__main__":
    unittest.main()
