#!/usr/bin/env bash
# Installs one pinned git+ source with pip, then asserts the distribution
# actually installed IS that source: the dist's direct_url.json must record a
# vcs commit exactly equal to the pin's. Exits nonzero — printing the log
# tail — when the install fails or the installed commit is not the pin's, so
# a caller (run-all.sh) can fail the run instead of swallowing the exit code.
#
# usage: install-pinned.sh PYTHON_BIN LOG_FILE DIST_NAME EXPECTED_COMMIT \
#          [--force-reinstall] "NAME[extras] @ git+https://…@<commit>#subdirectory=…"
#
# DIST_NAME is the distribution's module-style name (cogworks_benchmark,
# cogworks_week2_vision_benchmark, …) used to find its dist-info record.
set -euo pipefail

PYTHON_BIN=$1
LOG_FILE=$2
DIST_NAME=$3
EXPECTED_COMMIT=$4
shift 4
FORCE=""
if [ "${1:-}" = "--force-reinstall" ]; then
  FORCE=--force-reinstall
  shift
fi
SPEC=${1:?usage: install-pinned.sh PYTHON_BIN LOG_FILE DIST_NAME EXPECTED_COMMIT [--force-reinstall] SPEC}

if ! "$PYTHON_BIN" -m pip install --quiet $FORCE "$SPEC" >"$LOG_FILE" 2>&1; then
  echo "pip install failed: $SPEC (log: $LOG_FILE)" >&2
  tail -5 "$LOG_FILE" >&2
  exit 1
fi

# pip records a git install's resolved commit under vcs_info (the url loses
# the #subdirectory fragment). Read the record the installed dist ships.
PYSCRIPT='import glob, json, os, sys
names = glob.glob(os.path.join(sys.prefix, "lib", f"python{sys.version_info[0]}.{sys.version_info[1]}", "site-packages", "*.dist-info", "direct_url.json"))
for path in names:
    if sys.argv[1] in path:
        record = json.load(open(path))
        info = record.get("vcs_info") or {}
        print(info.get("commit_id", ""))
        print(record.get("url", ""))
        break
'
readarray -t PARTS < <("$PYTHON_BIN" -c "$PYSCRIPT" "$DIST_NAME")
INSTALLED_COMMIT=${PARTS[0]:-}
INSTALLED_URL=${PARTS[1]:-}

if [ -z "$INSTALLED_COMMIT" ]; then
  echo "install-pinned: $DIST_NAME recorded no vcs commit in its direct_url.json (url: ${INSTALLED_URL:-none}); this is not the pinned install" >&2
  exit 1
fi
if [ "$INSTALLED_COMMIT" != "$EXPECTED_COMMIT" ]; then
  echo "install-pinned: $DIST_NAME installed at $INSTALLED_COMMIT, not the pinned $EXPECTED_COMMIT (url: $INSTALLED_URL)" >&2
  exit 1
fi
echo "install-pinned: $DIST_NAME installed at $INSTALLED_COMMIT == pin (url: $INSTALLED_URL)"
