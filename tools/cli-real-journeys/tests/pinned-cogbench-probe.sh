#!/usr/bin/env bash
# The audio-spec probe must work against every cogbench the pin matrix can
# put in an env, including the PINNED one: the staging CLI's BenchmarkInstall
# predates the `extras` field, so a probe that reads `install.extras` crashes
# with AttributeError exactly where this suite hit it (week3's env, whose
# audio benchmark is not prebaked, imports the pinned cogbench).
#
# Demonstrated against a shim whose BenchmarkInstall mirrors the pinned
# cogbench's shape (distribution, source — no extras):
#   - the old probe line (install.extras) fails with AttributeError;
#   - the live line from run-all.sh (getattr default '') prints the spec.
#
# Run: bash tests/pinned-cogbench-probe.sh  (no network, no stack)
set -euo pipefail
cd "$(dirname "$0")/.."

shim_dir=$(mktemp -d)
trap 'rm -rf "$shim_dir"' EXIT
mkdir -p "$shim_dir/cogbench"
cat > "$shim_dir/cogbench/__init__.py" <<'PY'
PY
cat > "$shim_dir/cogbench/plugins.py" <<'PY'
from typing import NamedTuple


class BenchmarkInstall(NamedTuple):
    distribution: str
    source: str


BENCHMARK_INSTALLS = {
    "audio-identification": BenchmarkInstall(
        "cogworks-week1-audio-benchmark",
        "git+https://github.com/SamGu-NRX/cogworks-week1-audio-benchmark.git"
        "@4e516f39ffbeefe579e093260b2865eb354c17a7",
    ),
}
PY

# The probe exactly as run-all.sh ships it, extracted so the test cannot drift
# from the line it guards.
probe=$(grep -o "from cogbench.plugins import BENCHMARK_INSTALLS[^\"]*" run-all.sh | head -1)
if [ -z "$probe" ]; then
  echo "FAIL: the audio-spec probe was not found in run-all.sh" >&2
  exit 1
fi

# Red: the reviewed shape (install.extras) against the pinned cogbench's field set.
old_probe=$(printf '%s' "$probe" | sed "s/getattr(install, 'extras', '')/install.extras/")
if [ "$old_probe" = "$probe" ]; then
  echo "FAIL: could not reconstruct the old extras probe for the red step" >&2
  exit 1
fi
if PYTHONPATH="$shim_dir" python3 -c "$old_probe" >"$shim_dir/red.out" 2>"$shim_dir/red.err"; then
  echo "FAIL: the old probe unexpectedly succeeded against the pinned cogbench shape" >&2
  cat "$shim_dir/red.out"
  exit 1
fi
grep -q "AttributeError" "$shim_dir/red.err" || {
  echo "FAIL: the old probe failed for the wrong reason:" >&2
  cat "$shim_dir/red.err"
  exit 1
}

# Green: the shipped probe prints the spec from the pinned cogbench's fields.
spec=$(PYTHONPATH="$shim_dir" python3 -c "$probe")
expected="cogworks-week1-audio-benchmark @ git+https://github.com/SamGu-NRX/cogworks-week1-audio-benchmark.git@4e516f39ffbeefe579e093260b2865eb354c17a7"
if [ "$spec" != "$expected" ]; then
  echo "FAIL: the probe printed an unexpected spec:" >&2
  echo "  got:      $spec" >&2
  echo "  expected: $expected" >&2
  exit 1
fi

echo "pinned-cogbench-probe: red (install.extras -> AttributeError) and green (shipped probe -> $spec)"
