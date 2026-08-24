from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.plugins import (  # noqa: E402
    PluginError,
    load_plugin,
    load_submission,
    plugin_names,
)


class FakeEntryPoint:
    def __init__(self, name, value, loaded):
        self.name = name
        self.value = value
        self._loaded = loaded

    def load(self):
        return self._loaded


class PluginDiscoveryTests(unittest.TestCase):
    @patch("cogbench.plugins._entry_points")
    def test_identical_editable_metadata_is_deduplicated(self, entry_points):
        adapter = object()
        entry_points.return_value = [
            FakeEntryPoint("vision-recognition", "submission:Adapter", adapter),
            FakeEntryPoint("vision-recognition", "submission:Adapter", adapter),
        ]

        self.assertEqual(plugin_names("cogworks.submissions.v1"), ["vision-recognition"])
        self.assertIs(
            load_plugin("cogworks.submissions.v1", "vision-recognition"),
            adapter,
        )

    @patch("cogbench.plugins._entry_points")
    def test_distinct_implementations_remain_ambiguous(self, entry_points):
        entry_points.return_value = [
            FakeEntryPoint("vision-recognition", "first:Adapter", object()),
            FakeEntryPoint("vision-recognition", "second:Adapter", object()),
        ]

        with self.assertRaisesRegex(PluginError, "More than one"):
            load_plugin("cogworks.submissions.v1", "vision-recognition")

    @patch("cogbench.plugins._entry_points")
    def test_v2_submission_class_is_loaded_as_raw_factory(self, entry_points):
        class Factory:
            pass

        entry_points.return_value = [
            FakeEntryPoint("vision-recognition", "submission:Factory", Factory)
        ]

        self.assertIs(
            load_submission("vision-recognition", "cogworks.submissions.v2"),
            Factory,
        )


if __name__ == "__main__":
    unittest.main()


class AMissingBenchmarkReadsLikeAnAnswer(unittest.TestCase):
    """`run` and `check` meet the same situation and used to disagree.

    A student who has not installed the week's benchmark package gets a clear
    sentence from `cogworks check`: "Nothing was searched for, because
    audio-identification is not installed here. Install it, then run this
    again." From `cogworks run` they used to get 'Entry-point group
    "cogworks.benchmarks.v1" has no "audio-identification" registration
    (available: none)', which names a Python packaging concept, offers no
    next step, and arrives after they have done more work.
    """

    def test_nothing_installed_names_the_package_and_the_next_step(self):
        from cogbench.plugins import PluginError, load_plugin

        with self.assertRaises(PluginError) as caught:
            load_plugin("cogworks.benchmarks.absent-group-for-this-test", "week-9")
        message = str(caught.exception)

        self.assertIn("week-9", message)
        self.assertIn("not installed here", message)
        self.assertIn("run this again", message)
        # Our vocabulary, not theirs.
        self.assertNotIn("Entry-point", message)
        self.assertNotIn("registration", message)

    def test_a_wrong_name_still_lists_what_is_there(self):
        """When something IS installed the likely fault is a name or a
        version rather than an absence, and listing the alternatives is the
        useful thing rather than noise."""

        from cogbench.plugins import PluginError, load_plugin

        with self.assertRaises(PluginError) as caught:
            load_plugin("cogworks.benchmarks.v1", "audio-identifcation")
        message = str(caught.exception)
        self.assertIn("audio-identifcation", message)
        # Either branch is correct here depending on what this interpreter has
        # installed; both must name the thing asked for and neither may leak
        # the packaging vocabulary.
        self.assertNotIn("Entry-point", message)
