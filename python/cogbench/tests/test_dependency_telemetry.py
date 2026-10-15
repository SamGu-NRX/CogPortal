"""The CLI turns off usage pings its benchmarks' dependencies send on import.

Week 2's `datasets` dependency sends a HEAD request to s3.amazonaws.com on
every `load_dataset()` unless HF_UPDATE_DOWNLOAD_COUNTS is false. The
cli-real-journeys egress witness caught it during `cogworks test --benchmark
vision-recognition`: a request to a host no student document names.
"""

from __future__ import annotations

import io
import os
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.cli import main  # noqa: E402

OPT_OUTS = {"HF_UPDATE_DOWNLOAD_COUNTS": "0", "HF_HUB_DISABLE_TELEMETRY": "1"}


class DependencyTelemetryTests(unittest.TestCase):
    def test_main_sets_the_opt_outs_before_any_benchmark_loads(self):
        with patch.dict(os.environ, {}, clear=False):
            for name in OPT_OUTS:
                os.environ.pop(name, None)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(main([]), 0)
            self.assertEqual({name: os.environ.get(name) for name in OPT_OUTS}, OPT_OUTS)

    def test_a_value_the_student_set_is_kept(self):
        with patch.dict(os.environ, {"HF_UPDATE_DOWNLOAD_COUNTS": "1", "HF_HUB_DISABLE_TELEMETRY": "0"}):
            with redirect_stdout(io.StringIO()):
                main([])
            self.assertEqual(os.environ["HF_UPDATE_DOWNLOAD_COUNTS"], "1")
            self.assertEqual(os.environ["HF_HUB_DISABLE_TELEMETRY"], "0")


if __name__ == "__main__":
    unittest.main()
