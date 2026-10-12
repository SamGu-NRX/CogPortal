#!/usr/bin/env bash
# The unique per-run results directory: RUN_TAG plus a run-unique suffix
# (UTC timestamp, pid, random tail). A reused RUN_TAG - or two runs started
# in the same second - therefore never share a directory, so the state root
# a run derives from it (<results>/state, the wrangler --persist-to root)
# is always fresh: a reused RUN_TAG once re-migrated over the previous
# run's D1 and the new run's cases were judged against another run's
# database. RUN_TAG groups runs; the suffix isolates them.
#
# Usage: state-dir.sh BASE_DIR RUN_TAG   (echoes the directory)
set -euo pipefail
BASE_DIR=${1:?usage: state-dir.sh BASE_DIR RUN_TAG}
RUN_TAG=${2:?usage: state-dir.sh BASE_DIR RUN_TAG}
printf '%s\n' "$BASE_DIR/$RUN_TAG/$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}${RANDOM}"
