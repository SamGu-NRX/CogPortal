"""Path setup for the run-interference test suite.

``python -m pytest -q experiments/run-interference/tests`` from the
repository root must be able to import the study's modules (evidence,
detector, fixtures, supervisor) and the repo's real cogbench package, none
of which are installed anywhere. The inserts are idempotent and mirror what
``supervisor.ensure_import_paths`` does at import time.
"""

from __future__ import annotations

import sys
from pathlib import Path

STUDY = Path(__file__).resolve().parents[1]
REPO_ROOT = STUDY.parents[1]
COGBENCH_SRC = REPO_ROOT / "python" / "cogbench" / "src"

for _path in (str(COGBENCH_SRC), str(STUDY)):
    if _path not in sys.path:
        sys.path.insert(0, _path)
