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
