from __future__ import annotations

import json
from importlib import resources
from typing import Any, Dict, List, Sequence, Tuple

from cogbench.models import Metric


class VisionRecognitionBenchmark:
    """Small public contract fixture; official datasets and labels are external."""

    benchmark_id = "vision-recognition"
    benchmark_version = 1
    contract_version = "cogworks.submissions.v1"
    plugin_version = "0.1.0"
    scorer_version = "1"

    def public_cases(self) -> List[Dict[str, Any]]:
        package = resources.files(__package__) if hasattr(resources, "files") else None
        if package is not None:
            raw = package.joinpath("public_cases.json").read_text(encoding="utf-8")
        else:  # Python 3.8
            raw = resources.read_text(__package__, "public_cases.json", encoding="utf-8")
        return list(json.loads(raw))

    def score(
        self,
        predictions: Sequence[Any],
        expected: Sequence[Any],
    ) -> Tuple[List[Metric], List[str]]:
        if len(predictions) != len(expected):
            raise ValueError("Prediction count does not match the public cases.")
        correct = sum(str(prediction) == str(target) for prediction, target in zip(predictions, expected))
        accuracy = correct / len(expected) if expected else 0.0
        diagnostics = []
        if accuracy < 1.0:
            diagnostics.append(
                "{} of {} public practice cases matched. Inspect label normalization and unknown rejection.".format(
                    correct, len(expected)
                )
            )
        return (
            [
                Metric(
                    key="recognition_accuracy",
                    label="Public recognition accuracy",
                    value=accuracy,
                    unit=None,
                    higher_is_better=True,
                    primary=True,
                    precision=3,
                )
            ],
            diagnostics,
        )
