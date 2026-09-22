"""Check trusted benchmark declarations before a pin reaches hosted runs."""

from __future__ import annotations

from collections.abc import Mapping


def validate_metric_metadata(benchmark) -> None:
    name = benchmark.benchmark_id
    labels = benchmark.metric_labels
    if not isinstance(labels, Mapping) or not labels:
        raise ValueError("{}: metric_labels must be a nonempty mapping".format(name))
    for key, label in labels.items():
        if not isinstance(key, str) or not key or not isinstance(label, str) or not label:
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

    help_text = getattr(benchmark, "metric_help", {})
    if not isinstance(help_text, Mapping):
        raise ValueError("{}: metric_help must be a mapping when supplied".format(name))
    for key, text in help_text.items():
        if key not in labels:
            raise ValueError("{}: metric_help key {!r} is not declared in metric_labels".format(name, key))
        if not isinstance(text, str):
            raise ValueError("{}: metric_help[{!r}] must be a string".format(name, key))
