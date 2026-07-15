from __future__ import annotations

import unittest
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "examples" / "week2-vision-submission" / "src"))

from cogworks_week2_submission import Week2VisionSubmission


class Week2VisionSubmissionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.submission = Week2VisionSubmission()
        self.references = {
            "ada": [1.0, 0.0, 0.0],
            "grace": [0.0, 1.0, 0.0],
        }

    def test_predicts_known_and_unknown_embeddings(self) -> None:
        predictions = self.submission.predict(
            [
                {"embedding": [0.98, 0.02, 0.01], "references": self.references},
                {"embedding": [0.03, 0.97, 0.02], "references": self.references},
                {"embedding": [0.1, 0.1, 0.98], "references": self.references},
            ]
        )

        self.assertEqual(predictions, ["ada", "grace", "unknown"])

    def test_rejects_mismatched_vector_dimensions(self) -> None:
        with self.assertRaisesRegex(ValueError, "same length"):
            self.submission.predict(
                [{"embedding": [1.0, 0.0], "references": self.references}]
            )

    def test_rejects_zero_vectors(self) -> None:
        with self.assertRaisesRegex(ValueError, "non-zero"):
            self.submission.predict(
                [{"embedding": [0.0, 0.0, 0.0], "references": self.references}]
            )


if __name__ == "__main__":
    unittest.main()
