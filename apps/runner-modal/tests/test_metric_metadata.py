from __future__ import annotations

import importlib
import sys
import unittest
from importlib.util import find_spec
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))

from validate_metric_metadata import validate_metric_metadata


class MetricMetadataTests(unittest.TestCase):
    def setUp(self):
        self.benchmark = SimpleNamespace(
            benchmark_id="language-search",
            primary_metric="overall",
            metric_labels={"overall": "Overall", "search_mrr": "Search MRR"},
        )

    def test_declared_sweep_metric_is_valid(self):
        self.benchmark.sweep_metric = "search_mrr"
        validate_metric_metadata(self.benchmark)

    def test_unknown_sweep_metric_names_the_benchmark_and_declarations(self):
        self.benchmark.sweep_metric = "search_mmr"
        with self.assertRaises(ValueError) as caught:
            validate_metric_metadata(self.benchmark)
        self.assertEqual(
            str(caught.exception),
            "language-search: sweep_metric 'search_mmr' is not declared in "
            "metric_labels (overall, search_mrr)",
        )
        self.assertEqual(self.benchmark.sweep_metric, "search_mmr")

    def test_missing_or_none_sweep_metric_keeps_the_primary_fallback(self):
        validate_metric_metadata(self.benchmark)
        self.benchmark.sweep_metric = None
        validate_metric_metadata(self.benchmark)

    def test_invalid_explicit_sweep_metric_is_not_silently_relabelled(self):
        for value in ("", 42, []):
            with self.subTest(value=value):
                self.benchmark.sweep_metric = value
                with self.assertRaisesRegex(ValueError, "sweep_metric.*not declared"):
                    validate_metric_metadata(self.benchmark)

    def test_unknown_primary_metric_is_rejected(self):
        self.benchmark.primary_metric = "total"
        with self.assertRaisesRegex(ValueError, "primary_metric 'total'.*not declared"):
            validate_metric_metadata(self.benchmark)

    def test_declared_metric_labels_are_required(self):
        for labels in (None, [], {}, {"": "Empty"}, {"overall": 7}):
            with self.subTest(labels=labels):
                self.benchmark.metric_labels = labels
                with self.assertRaisesRegex(ValueError, "metric_labels"):
                    validate_metric_metadata(self.benchmark)

    def test_valid_long_help_is_not_capped_or_changed(self):
        for length in (645, 5_000):
            with self.subTest(length=length):
                text = "A" + "x" * (length - 2) + "."
                self.assertEqual(len(text), length)
                self.benchmark.metric_help = {"overall": text, "search_mrr": text}
                validate_metric_metadata(self.benchmark)
                self.assertEqual(self.benchmark.metric_help["search_mrr"], text)

    def test_optional_help_can_be_absent(self):
        validate_metric_metadata(self.benchmark)

    def test_explicit_none_help_is_rejected_before_the_runner_reads_it(self):
        self.benchmark.metric_help = None
        with self.assertRaisesRegex(ValueError, "metric_help must be a mapping"):
            validate_metric_metadata(self.benchmark)

    def test_help_cannot_describe_an_undeclared_metric(self):
        self.benchmark.metric_help = {"search_mmr": "A misspelled metric."}
        with self.assertRaisesRegex(ValueError, "metric_help key 'search_mmr'.*not declared"):
            validate_metric_metadata(self.benchmark)

    def test_help_uses_a_mapping_of_strings(self):
        for help_text in ([], {"overall": 42}, {"overall": None}):
            with self.subTest(help_text=help_text):
                self.benchmark.metric_help = help_text
                with self.assertRaisesRegex(ValueError, "metric_help"):
                    validate_metric_metadata(self.benchmark)


class InstalledProducerValidationTests(unittest.TestCase):
    def check_producer(self, week, name):
        if find_spec("cogbench") is None:
            self.skipTest("needs the installed SDK")
        from cogbench.plugins import load_plugin, plugin_names

        if name not in plugin_names("cogworks.benchmarks.v2"):
            self.skipTest("{} is not installed in this lane".format(name))
        validator = importlib.import_module("validate_week{}_submodule".format(week))
        producer = load_plugin("cogworks.benchmarks.v2", name, instantiate_classes=False)
        validator.main()
        with patch.object(producer, "sweep_metric", "misspelled_metric", create=True):
            with self.assertRaisesRegex(ValueError, name + ": sweep_metric 'misspelled_metric'"):
                validator.main()
        help_text = {key: "A" + "x" * 4_998 + "." for key in producer.metric_labels}
        with patch.object(producer, "metric_help", help_text):
            validator.main()
            self.assertEqual(producer.metric_help, help_text)

    def test_week1_validator_checks_the_registered_producer(self):
        self.check_producer(1, "audio-identification")

    def test_week2_recognition_validator_checks_the_registered_producer(self):
        self.check_producer(2, "vision-recognition")

    def test_week2_clustering_validator_checks_the_registered_producer(self):
        self.check_producer(2, "vision-clustering")

    def test_week3_validator_checks_the_registered_producer(self):
        self.check_producer(3, "language-search")


if __name__ == "__main__":
    unittest.main()
