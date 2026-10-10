"""Test paths for the process-signals study: repo root and cogbench on sys.path."""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parents[1]
for candidate in [str(HERE), str(REPO_ROOT), str(REPO_ROOT / "python" / "cogbench" / "src")]:
    if candidate not in sys.path:
        sys.path.insert(0, candidate)
