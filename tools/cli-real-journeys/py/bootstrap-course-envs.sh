#!/usr/bin/env bash
# Creates the course's conda environments (week1/week2/week3 on Python 3.8) and
# the version-matrix environments (py311/py313). Idempotent; safe to rerun.
#
# conda-forge rather than the defaults channels: the defaults channels now
# require accepting their Terms of Service, which this workspace has not done,
# and conda-forge carries the same CPython builds (3.8.20 and friends).
set -euo pipefail
CONDA_ROOT=${CONDA_ROOT:-/home/user/work/miniconda3}
CONDA="$CONDA_ROOT/bin/conda"

if [ ! -x "$CONDA" ]; then
  echo "Miniconda not found at $CONDA_ROOT; install it or set CONDA_ROOT." >&2
  exit 1
fi

create() {
  local name=$1 ver=$2
  [ -d "$CONDA_ROOT/envs/$name" ] && return 0
  "$CONDA" create -y -n "$name" -c conda-forge --override-channels "python=$ver"
}

create week1 3.8
create week2 3.8
create week3 3.8
create py311 3.11
create py313 3.13
