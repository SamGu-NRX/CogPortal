#!/usr/bin/env bash
# The pin matrix's week2/week3 cells run the full real-data journeys under a
# PINNED cogbench. Those journeys import each week's model stack in the env
# that executes `cogworks` (runner.py: `from facenet_models import
# FacenetModel` -> "FaceNet is not installed" without it), so each cell must
# install the pinned cogbench's own WEEK*_TRACK into its env before the
# journey runs. This test proves the step is wired into run-all.sh and that
# the step's body installs exactly the track the (shimmed) cogbench declares,
# failing loudly when an install fails - the red side is the previous script,
# which provisioned nothing and made every fresh-bootstrap week2 cell fail
# with the FaceNet ContractError.
#
# The red case is the pre-fix script itself: run-all.sh at b74237c3, the
# parent of the commit that added the step (c722ed79), read by full SHA. It is
# fetched from origin when a shallow checkout lacks it, and a missing revision
# fails the test rather than skipping the red case.
set -uo pipefail
cd "$(dirname "$0")/.."

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

PRE_FIX=b74237c378277bf4d03977c9f2cf9f29a960efbe
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# The track-install body a script runs in its week cells, with the track name
# substituted, or nothing when the script has no such step.
track_body() {
  sed -n '/if "\$env_bin\/python" - >"\$track_log" 2>&1 <<PY$/,/^PY$/p' "$1" \
    | sed '1d;$d' | sed 's/\$track_name/WEEK2_TRACK/g'
}

# Wiring: the step exists, and it runs before the week's real-data journey.
wired() {
  local step journey
  step=$(grep -n 'if "\$env_bin/python" - >"\$track_log" 2>&1 <<PY$' "$1" | head -1 | cut -d: -f1)
  journey=$(grep -n 'journeys/real-data-week\$week_num.ts' "$1" | head -1 | cut -d: -f1)
  [ -n "$step" ] && [ -n "$journey" ] && [ "$step" -lt "$journey" ] && [ -n "$(track_body "$1")" ]
}

# ---------------------------------------------------------------------------
# 1. Wiring: red on the pre-fix script, green on the current one.
# ---------------------------------------------------------------------------
REPO_ROOT=$(git rev-parse --show-toplevel)
if ! git -C "$REPO_ROOT" cat-file -e "$PRE_FIX^{commit}" 2>/dev/null; then
  git -C "$REPO_ROOT" fetch --quiet --depth=1 origin "$PRE_FIX" \
    || fail "the pre-fix revision $PRE_FIX is not available; the red case cannot run"
fi
git -C "$REPO_ROOT" show "$PRE_FIX:tools/cli-real-journeys/run-all.sh" >"$WORK/run-all.pre-fix.sh" \
  || fail "could not read run-all.sh at $PRE_FIX"

wired "$WORK/run-all.pre-fix.sh" \
  && fail "the pre-fix script ($PRE_FIX) passes the wiring check, so the check cannot detect the missing step"
pass "red: the pre-fix script's week cells provision no track"
wired run-all.sh || fail "the week cells do not provision the pinned cogbench's environment track before the journey"
pass "green: the current script provisions the track before the real-data journey"

# ---------------------------------------------------------------------------
# 2. Behavior: the step's body (extracted verbatim from run-all.sh so it
#    cannot drift) installs the shim track's packages into a fresh venv and
#    exits non-zero when an install fails.
# ---------------------------------------------------------------------------
body=$(track_body run-all.sh)
[ -n "$body" ] || fail "could not extract the track-install body from run-all.sh"

# A shim cogbench.environment whose WEEK2_TRACK is tiny and real.
shim="$WORK/shim/cogbench"
mkdir -p "$shim"
cat >"$shim/__init__.py" <<'EOF'
EOF
cat >"$shim/environment.py" <<'EOF'
from typing import NamedTuple, Tuple

class Package(NamedTuple):
    requirement: str
    module: str

WEEK2_TRACK: Tuple[Package, ...] = (
    Package("six==1.16.0", "six"),
)
EOF

python_bin=$(command -v python3)
"$python_bin" -m venv "$WORK/venv" || fail "could not create the test venv"

run_body() {  # runs the extracted body under the shimmed track
  PYTHONPATH="$WORK/shim" "$WORK/venv/bin/python" - <<PY
$body
PY
}

if run_body >>"$WORK/track.log" 2>&1; then
  pass "the step installs the shim track's package and exits 0"
else
  cat "$WORK/track.log" >&2
  fail "the track-install step exited non-zero on an installable track"
fi
"$WORK/venv/bin/python" -c "import six" 2>/dev/null \
  || fail "six (from the shim track) is not importable after the step ran"
pass "the installed track requirement is real: six imports in the target env"

# Failure path: a track entry pip cannot satisfy must fail the step loudly -
# the run-all.sh wiring turns that non-zero exit into FAILED=1.
cat >"$shim/environment.py" <<'EOF'
from typing import NamedTuple, Tuple

class Package(NamedTuple):
    requirement: str
    module: str

WEEK2_TRACK: Tuple[Package, ...] = (
    Package("six==1.16.0", "six"),
    Package("cogworks-week-track-missing-package>=999", "missing"),
)
EOF

if run_body >>"$WORK/track-fail.log" 2>&1; then
  fail "the track-install step exited 0 despite an unsatisfiable requirement"
fi
pass "the step exits non-zero when a track requirement cannot install"

echo "week2-track-provision: all checks passed"
