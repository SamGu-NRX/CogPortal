#!/usr/bin/env bash
# The suite's own tests: every review fix ships with the test that proves it.
# These run against real installs and real git state; they do not boot the
# stack (run-all.sh does that once, at the end).
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
for test_script in tests/*.ts; do
  echo "=== $test_script"
  if ! npx tsx "$test_script"; then
    echo "=== $test_script FAILED"
    fail=1
  fi
done
for test_script in tests/*.sh; do
  [ "$(basename "$test_script")" = "run.sh" ] && continue
  echo "=== $test_script"
  if ! bash "$test_script"; then
    echo "=== $test_script FAILED"
    fail=1
  fi
done
exit "$fail"
