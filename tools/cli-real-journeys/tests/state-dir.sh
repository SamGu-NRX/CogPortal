#!/usr/bin/env bash
# The per-run state contract: a reused RUN_TAG must never reuse a state
# directory. Two invocations of support/state-dir.sh with the same tag get
# distinct directories, whatever the first run leaves in its D1 state root
# is invisible to the second, and run-all.sh actually derives its results
# directory through the helper.
set -uo pipefail
cd "$(dirname "$0")/.."

failures=0
check() {
  local name=$1 condition=$2 detail=$3
  if [ "$condition" = "1" ]; then
    echo "[FAIL] $name — $detail"
    failures=$((failures + 1))
  else
    echo "[ok] $name — $detail"
  fi
}

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

dir1=$(bash support/state-dir.sh "$scratch" sametag)
dir2=$(bash support/state-dir.sh "$scratch" sametag)
check "two runs with the same RUN_TAG get distinct directories" \
  "$([ "$dir1" != "$dir2" ] && echo 0 || echo 1)" \
  "run 1: $dir1; run 2: $dir2"

# The D1 consequence: whatever run 1's state root holds (the migrated,
# seeded database), run 2's fresh state root must not contain it.
mkdir -p "$dir1/state/v3" "$dir2/state/v3"
printf 'run-one-d1' >"$dir1/state/v3/d1.sqlite"
check "run 2's D1 state is fresh - run 1's database is not in it" \
  "$([ ! -e "$dir2/state/v3/d1.sqlite" ] && echo 0 || echo 1)" \
  "run 1 left $(printf '%s' "$dir1/state/v3/d1.sqlite"); run 2's state root: $dir2/state/v3"

check "run-all.sh derives its results directory through state-dir.sh" \
  "$(grep -q 'RESULTS=\$(bash support/state-dir.sh' run-all.sh && echo 0 || echo 1)" \
  "run-all.sh sources the helper for RESULTS"

if [ "$failures" -gt 0 ]; then
  echo "state-dir: $failures check(s) failed"
  exit 1
fi
echo "state-dir: all checks passed"
