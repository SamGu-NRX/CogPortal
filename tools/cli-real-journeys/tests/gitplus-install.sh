#!/usr/bin/env bash
# The git+-install contract (review block: "git+ installs"), demonstrated
# against real pip runs in a scratch venv.
#
# The benchmark source run-all.sh reads from the pinned portal revision must
# keep its git+ scheme — pip can only follow a git repository through a git+
# direct reference — and every install must fail the run when it fails or
# when the installed commit is not the pin's.
#
#   red A  an invalid ref (a commit that does not exist) fails the install
#   red B  the OLD stripped-git+ spec cannot be followed by pip — it fails
#          loudly instead of silently mis-installing
#   red C  a valid install of the WRONG commit fails the commit assertion
#   green  the real pin installs and its commit is asserted equal
#
# Run: bash tests/gitplus-install.sh  (network: two GitHub pip installs)
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_ROOT=$(cd ../.. && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
python3 -m venv "$scratch/venv"
PY="$scratch/venv/bin/python"

pin_from() { # git revision -> the git+ COGBENCH_SOURCE its file declares
  git -C "$REPO_ROOT" show "$1:apps/portal/src/lib/benchmark-packages.ts" \
    | sed -n 's/^[[:space:]]*"git+\([^"]*\)".*$/git+\1/p' | head -1
}
commit_of() { printf '%s' "$1" | sed -n 's/.*@\([0-9a-f]\{40\}\).*/\1/p'; }

beta_pin=$(pin_from origin/beta)
beta_commit=$(commit_of "$beta_pin")
# The old wiring's beta label: the file read at the CLI commit itself.
old_beta_pin=$(pin_from 064400e9cf65874b87fe888fc6fd14a564095c5e)
old_beta_commit=$(commit_of "$old_beta_pin")
fail=0

# red A: an install failure must fail (no swallowed exit codes).
if ./support/install-pinned.sh "$PY" "$scratch/a.log" "cogworks_benchmark" "$beta_commit" \
  "cogworks-benchmark @ git+https://github.com/SamGu-NRX/CogPortal.git@0000000000000000000000000000000000000000#subdirectory=python/cogbench" \
  2>"$scratch/a.err"; then
  echo "[FAIL] an install from an invalid ref must fail"
  fail=1
else
  echo "[ok] an invalid ref fails the install step — $(tail -1 "$scratch/a.err")"
fi

# red B: with git+ stripped (the old defect), pip cannot follow the pin.
if ./support/install-pinned.sh "$PY" "$scratch/b.log" "cogworks_benchmark" "$beta_commit" \
  "cogworks-benchmark @ ${beta_pin#git+}" \
  2>"$scratch/b.err"; then
  echo "[FAIL] the git+-stripped spec must not install"
  fail=1
else
  echo "[ok] pip refuses the git+-stripped source — $(tail -1 "$scratch/b.err")"
fi

# red C: a valid install of the wrong commit fails the commit assertion.
if ./support/install-pinned.sh "$PY" "$scratch/c.log" "cogworks_benchmark" "$beta_commit" \
  --force-reinstall "cogworks-benchmark @ $old_beta_pin" \
  2>"$scratch/c.err"; then
  echo "[FAIL] an install of the wrong commit must fail the assertion (installed $old_beta_commit, pin $beta_commit)"
  fail=1
else
  echo "[ok] the installed-commit assertion catches a swapped pin — $(tail -1 "$scratch/c.err")"
fi

# green: the real pin installs and its commit is asserted.
if ./support/install-pinned.sh "$PY" "$scratch/g.log" "cogworks_benchmark" "$beta_commit" \
  --force-reinstall "cogworks-benchmark @ $beta_pin"; then
  echo "[ok] the pinned install passes with its commit asserted equal ($beta_commit)"
else
  echo "[FAIL] the pinned install should pass — $(tail -5 "$scratch/g.log")"
  fail=1
fi

exit "$fail"
