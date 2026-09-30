"""Check trusted benchmark declarations before a pin reaches hosted runs."""

from __future__ import annotations

from collections.abc import Mapping

# SweepSchema (packages/contracts/src/protocol.ts) and the stored run's sweep
# (packages/contracts/src/schema.ts) cap both strings at this length. A longer one
# fails the completed event, so the run cannot finish.
SWEEP_TEXT_LIMIT = 60


def validate_metric_metadata(benchmark) -> None:
    name = benchmark.benchmark_id
    labels = benchmark.metric_labels
    if not isinstance(labels, Mapping) or not labels:
        raise ValueError("{}: metric_labels must be a nonempty mapping".format(name))
    for key, label in labels.items():
        if not isinstance(key, str) or not key.strip() or not isinstance(label, str) or not label.strip():
            raise ValueError("{}: metric_labels needs nonempty string keys and labels".format(name))

    for field in ("primary_metric", "sweep_metric"):
        declared = getattr(benchmark, field, None)
        # The consumer uses primary_metric when sweep_metric is absent or None.
        if field == "sweep_metric" and declared is None:
            continue
        if not isinstance(declared, str) or declared not in labels:
            raise ValueError(
                "{}: {} {!r} is not declared in metric_labels ({})".format(
                    name, field, declared, ", ".join(sorted(labels))
                )
            )

    # The runner draws a sweep only for a plugin that declares both keys.
    if getattr(benchmark, "sweep_x_key", None) and getattr(benchmark, "sweep_y_key", None):
        sweep_text = {
            "sweep metric": getattr(benchmark, "sweep_metric", None) or benchmark.primary_metric,
            "sweep_axis_label": getattr(benchmark, "sweep_axis_label", "difficulty"),
        }
        for field, text in sweep_text.items():
            if not isinstance(text, str) or not 1 <= len(text) <= SWEEP_TEXT_LIMIT:
                raise ValueError(
                    "{}: {} {!r} must be 1 to {} characters".format(name, field, text, SWEEP_TEXT_LIMIT)
                )

    help_text = getattr(benchmark, "metric_help", {})
    if not isinstance(help_text, Mapping):
        raise ValueError("{}: metric_help must be a mapping when supplied".format(name))
    for key, text in help_text.items():
        if key not in labels:
            raise ValueError("{}: metric_help key {!r} is not declared in metric_labels".format(name, key))
        if not isinstance(text, str):
            raise ValueError("{}: metric_help[{!r}] must be a string".format(name, key))
