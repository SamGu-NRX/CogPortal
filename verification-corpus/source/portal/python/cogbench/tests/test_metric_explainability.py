"""Every installed benchmark explains every number it reports.

The per-benchmark suites test their own wording. This one is the invariant
across all of them, and it runs in `pnpm test:python`, so a new benchmark
cannot ship a metric with no explanation just by living in its own repository.

The rule it enforces: a number a student cannot trace back to something they
were taught is a black box, and a black box teaches nothing. `metric_help`
carries one or two sentences per metric in the course's vocabulary, naming
which part of the capstone the number comes from.

Benchmarks that predate `metric_help` are skipped rather than failed -- Week 2
is one -- so this tightens over time instead of blocking on a rewrite. What it
will not tolerate is a benchmark that has the attribute and leaves holes in it.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

# Its own path, rather than whichever sibling ran first.
#
# This file had no sys.path line and passed anyway, because `test_cli.py` and
# two others insert the source directory and unittest discovers them in
# alphabetical order. Run alone it raised ModuleNotFoundError in setUp, which
# unittest counts as an error rather than a failure, so `pytest
# test_metric_explainability.py` reported five errors while the full suite
# reported OK. A test that only runs when a neighbour runs first is a test
# nobody can check.
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))


def _installed_benchmarks():
    """Every v2 benchmark plugin importable in this environment.

    Returns `(name, plugin)` pairs. A plugin whose import fails for a missing
    optional dependency is skipped with its name recorded: the point is to
    check the ones that are here, not to require all of them everywhere.
    """

    from cogbench.plugins import load_plugin, plugin_names

    found = []
    for name in plugin_names("cogworks.benchmarks.v2"):
        try:
            found.append((name, load_plugin("cogworks.benchmarks.v2", name)))
        except Exception:  # noqa: BLE001 - a missing extra is not a failure here
            continue
    return found


#: Words that mean something to us and nothing to a student reading a run
#: page. "tier" and "grid" are our vocabulary for how a corpus is laid out;
#: "harness", "driver", and "adapter" are our vocabulary for the machinery.
JARGON = ("grid cell", "the grid", "tier", "harness", "driver", "adapter", "manifest")


class MetricExplainability(unittest.TestCase):
    def setUp(self):
        self.benchmarks = _installed_benchmarks()
        if not self.benchmarks:
            self.skipTest("no v2 benchmark plugins are installed")

    def test_every_labeled_metric_is_explained(self):
        for name, plugin in self.benchmarks:
            help_text = getattr(plugin, "metric_help", None)
            if help_text is None:
                continue  # predates metric_help; see the module docstring
            labels = getattr(plugin, "metric_labels", {})
            missing = sorted(set(labels) - set(help_text))
            self.assertEqual(
                missing, [], "{} reports metrics with no explanation: {}".format(name, missing)
            )

    def test_no_explanation_describes_a_metric_that_is_not_reported(self):
        """A stale entry is worse than a missing one: it reads as current."""

        for name, plugin in self.benchmarks:
            help_text = getattr(plugin, "metric_help", None)
            if help_text is None:
                continue
            labels = getattr(plugin, "metric_labels", {})
            orphaned = sorted(set(help_text) - set(labels))
            self.assertEqual(
                orphaned, [], "{} explains metrics it does not report: {}".format(name, orphaned)
            )

    def test_the_primary_metric_is_explained(self):
        """The leaderboard number is the one a team will argue about."""

        for name, plugin in self.benchmarks:
            help_text = getattr(plugin, "metric_help", None)
            if help_text is None:
                continue
            self.assertIn(
                plugin.primary_metric,
                help_text,
                "{} does not explain its own primary metric".format(name),
            )

    def test_a_benchmark_declares_what_it_actually_reports(self):
        """The hole the three tests above leave open.

        They compare `metric_labels` against `metric_help`, so a metric that
        appears in neither is invisible to all of them. `score()` is what
        decides which numbers reach a run page, and the runner falls back to
        `key.replace("_", " ").title()` for anything unlabeled, so a metric
        added to the scorer and to nothing else renders as "Retrieval Mrr
        Verbatim" with no explanation. That is precisely the black box this
        file exists to prevent, arriving through the one door it did not
        watch.

        Found by adding `retrieval_mrr_verbatim` in scorer version
        retrieval-v4 and noticing by hand that nothing failed.

        A benchmark that cannot be scored without its real data is skipped
        rather than failed: it declares `sample_metric_keys` if it wants to
        be checked, and most can simply be run against their own fixtures.
        """

        for name, plugin in self.benchmarks:
            help_text = getattr(plugin, "metric_help", None)
            if help_text is None:
                continue
            keys = getattr(plugin, "sample_metric_keys", None)
            if not keys:
                continue
            labels = getattr(plugin, "metric_labels", {})
            undeclared = sorted(set(keys) - set(labels))
            self.assertEqual(
                undeclared,
                [],
                "{} reports metrics it never declares, so they reach a run "
                "page as a machine-made title with no explanation: {}".format(
                    name, undeclared
                ),
            )

    def test_explanations_are_sentences_in_the_student_vocabulary(self):
        for name, plugin in self.benchmarks:
            help_text = getattr(plugin, "metric_help", None)
            if help_text is None:
                continue
            for key, text in help_text.items():
                where = "{}.{}".format(name, key)
                self.assertGreater(len(text), 60, "{} is too short to explain anything".format(where))
                self.assertFalse(
                    text[0].islower(), "{} reads as a fragment, not a sentence".format(where)
                )
                self.assertTrue(
                    text.rstrip().endswith("."), "{} is not a complete sentence".format(where)
                )
                found = [word for word in JARGON if word in text.lower()]
                self.assertEqual(
                    found, [], "{} uses our vocabulary, not theirs: {}".format(where, found)
                )


if __name__ == "__main__":
    unittest.main()
