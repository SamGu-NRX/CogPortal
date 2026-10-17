#!/bin/sh
# Builds the Python 3.8 environment the CLI journeys run `cogworks` in: the
# checkout's CLI and the Week 1 audio benchmark, both editable, plus the Week 1
# reference submission's own requirements (numpy, scipy, matplotlib). Python
# 3.8 because that is the course's environment.
#
# Week 1 is the week these journeys score on because its public corpus is
# generated locally and hash-checked, so a run needs no download and no
# account; Week 2 fetches a FaceNet checkpoint and Week 3 needs GloVe.
#
#   git submodule update --init benchmarks/week1
#   tools/portal-real-journeys/stack/setup-python.sh
#
# The environment lands in tools/portal-real-journeys/.py38 (ignored by git),
# or in RJ_VENV. The journeys find it there, or take RJ_PYTHON.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
VENV=${RJ_VENV:-"$HERE/../.py38"}
PY38=${RJ_PYTHON38:-$(command -v python3.8 || echo "$HOME/.local/bin/python3.8")}

if [ ! -x "$PY38" ]; then
  echo "setup-python: no Python 3.8 at $PY38; install one or set RJ_PYTHON38" >&2
  exit 1
fi
case "$("$PY38" -c 'import sys; print("%d.%d" % sys.version_info[:2])')" in
  3.8) ;;
  *) echo "setup-python: $PY38 is not Python 3.8" >&2; exit 1 ;;
esac
if [ ! -f "$REPO/benchmarks/week1/pyproject.toml" ]; then
  echo "setup-python: benchmarks/week1 is empty; run git submodule update --init benchmarks/week1" >&2
  exit 1
fi

"$PY38" -m venv "$VENV"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
# The reference submission's bounds (examples/week1-audio-submission/pyproject.toml),
# numpy at the version CI's Python 3.8 lanes pin.
"$VENV/bin/python" -m pip install --quiet \
  -e "$REPO/python/cogbench" \
  -e "$REPO/benchmarks/week1" \
  "numpy==1.24.4" "scipy>=1.10,<1.13" "matplotlib>=3.5,<4"
"$VENV/bin/python" -m cogbench --version
echo "setup-python: ready at $VENV"
