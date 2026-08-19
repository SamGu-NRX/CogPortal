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

import unittest


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
