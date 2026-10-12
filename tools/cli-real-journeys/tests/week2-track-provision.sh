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
set -uo pipefail
cd "$(dirname "$0")/.."

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# 1. Wiring: the week cells' provisioning step exists (red on the old script).
# ---------------------------------------------------------------------------
old_script=$(git show HEAD:tools/cli-real-journeys/run-all.sh 2>/dev/null || git show HEAD:run-all.sh)
new_script=$(cat run-all.sh)

for script_name in old new; do
  script=$([ "$script_name" = old ] && echo "$old_script" || echo "$new_script")
  if grep -q 'from cogbench.environment import \$track_name' <<<"$script"; then
    echo "  $script_name script: week-cell track provisioning present"
  else
    if [ "$script_name" = new ]; then
      fail "the week cells do not provision the pinned cogbench's environment track"
    else
      echo "  old script: no week-cell track provisioning (the defect, as expected)"
    fi
  fi
done

# Red half: the old script must NOT contain the step (proves this test can
# detect its absence), the new script MUST.
grep -q 'from cogbench.environment import $track_name' <<<"$old_script" \
  && fail "the old script unexpectedly already provisions the week track"
grep -q 'from cogbench.environment import $track_name' <<<"$new_script" \
  || fail "the new script does not provision the week track"
pass "wiring: the old script lacks the step, the new script has it"

# ---------------------------------------------------------------------------
# 2. Behavior: the step's body (extracted verbatim from run-all.sh so it
#    cannot drift) installs the shim track's packages into a fresh venv and
#    exits non-zero when an install fails.
# ---------------------------------------------------------------------------
body=$(sed -n '/if "\$env_bin\/python" - >"\$track_log" 2>&1 <<PY$/,/^PY$/p' run-all.sh \
  | sed '1d;$d' | sed 's/\$track_name/WEEK2_TRACK/g')
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
