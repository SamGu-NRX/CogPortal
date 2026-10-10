import subprocess
import sys
from pathlib import Path

STUDY = Path(__file__).resolve().parents[1]

#: Modules that must stay blind to the defect/repair key.
BLIND_MODULES = ["measure.py", "diagnose.py", "oracle.py"]


def test_blind_modules_never_reference_the_key():
    for module in BLIND_MODULES:
        source = (STUDY / module).read_text(encoding="utf-8")
        assert "key.json" not in source, module
        assert "load_key" not in source, module
        assert "grade" not in source, module


def test_measurement_never_opens_the_key(tmp_path):
    """Run one real measurement under an audit hook that aborts on any open
    of key.json - interposition, not convention. Fixtures are materialized in
    the parent; the audited subprocess touches only the measurement layer."""
    import materialize as mat

    key = mat.load_key()  # fixture construction, parent only
    paths = mat.materialize(tmp_path, key)
    script = f"""
import sys
sys.path.insert(0, {str(STUDY)!r})

blocked = []

def hook(event, args):
    if event == "open":
        path = str(args[0])
        if path.endswith("key.json"):
            blocked.append(path)
            raise RuntimeError("measurement opened the key")

sys.addaudithook(hook)

import json
from pathlib import Path
import measure

bundle = measure.measure_variant(Path({str(paths['control'])!r}), with_run=False)
print(json.dumps({{"outcome": measure.outcome_of(bundle), "blocked": blocked}}))
"""
    proc = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert proc.returncode == 0, proc.stderr
    assert '"blocked": []' in proc.stdout
