"""Make the workbench modules importable to pytest without packaging."""

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_WORKBENCH = _HERE.parent

for _path in (str(_WORKBENCH), str(_HERE)):
    if _path not in sys.path:
        sys.path.insert(0, _path)
