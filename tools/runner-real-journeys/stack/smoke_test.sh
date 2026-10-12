#!/usr/bin/env bash
# Seven-check smoke suite wrapper — see smoke_test.py for the checks.
#   bash tools/runner-real-journeys/stack/smoke_test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$HERE/smoke_test.py" "$@"
