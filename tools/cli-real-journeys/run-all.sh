#!/usr/bin/env bash
# Run every CLI and CogBot journey against the real local stack, once, from
# fresh state. Three consecutive passes at one commit are the plan's M1 bar;
# .github/workflows/cli-real-journeys.yml runs them on fresh runners.
#
# Fresh state per run: a new results directory and D1 (support/state-dir.sh),
# and new virtual environments made from base interpreters for this run only,
# in the run's scratch directory, which the EXIT trap deletes. No environment,
# data cache or CLI HOME survives from an earlier run. Every receipt carries
# the commit the run tested (SUITE_HEAD), and the report fails a receipt that
# names another.
#
# Optional environment:
#   RUN_TAG            label grouping this run's results (default: run)
#   PY38 PY311 PY313   base interpreters (default: python3.8, python3.11, python3.13)
#   NODE24             a Node >= 22 prefix for build tools (default: the node on PATH)
#   KEEP_ENVS=1        keep this run's environments and data after it ends
set -euo pipefail
cd "$(dirname "$0")"

# No pre-boot command talks to a portal, and nothing downstream may inherit a
# caller's COGPORTAL_URL: the real origin is resolved from the booted stack,
# guarded, and re-exported there.
unset COGPORTAL_URL

REPO_ROOT=$(cd ../.. && pwd)
NODE24=${NODE24:-$(dirname "$(dirname "$(command -v node)")")}
export PATH="$NODE24/bin:$PATH"
PY38=${PY38:-python3.8}
PY311=${PY311:-python3.11}
PY313=${PY313:-python3.13}
RUN_TAG=${RUN_TAG:-run}
RESULTS=$(bash support/state-dir.sh "$PWD/results" "$RUN_TAG")
echo "results directory: $RESULTS"
# The run's D1/R2/DO state: wrangler's migrate and seed steps and the booted
# stack keep it here, never in the checkout's .wrangler. Exported for the
# device-name witness, which reads the same D1.
export SUITE_STATE="$RESULTS/state"
mkdir -p "$RESULTS/receipts"

# The commit this run tests. Receipts carry it; report.mjs fails any receipt
# that names another. A dirty tree is recorded, because then the run tested
# more than the commit.
SUITE_HEAD=$(git -C "$REPO_ROOT" rev-parse HEAD)
git -C "$REPO_ROOT" status --porcelain --untracked-files=no >"$RESULTS/git-status.txt"
SUITE_DIRTY=0
[ ! -s "$RESULTS/git-status.txt" ] || SUITE_DIRTY=1
export SUITE_HEAD SUITE_DIRTY
echo "testing $SUITE_HEAD (dirty=$SUITE_DIRTY)"
[ "$SUITE_DIRTY" = 0 ] || { echo "uncommitted changes to tracked files:"; cat "$RESULTS/git-status.txt"; }

# Per-run scratch: CLI homes, git fixtures, virtual environments, data. Under
# /tmp because tsx binds unix sockets under TMPDIR and a path through the
# checkout passes the 108-byte socket limit.
export TMPDIR="/tmp/cli-real-journeys-${RUN_TAG}-$(date -u +%H%M%SZ)-$$"
mkdir -p "$TMPDIR"
ENVS="$TMPDIR/envs"
mkdir -p "$ENVS"
export RESULTS_DIR="$RESULTS"
STACK_PID=""
cleanup() {
  if [ -n "$STACK_PID" ]; then
    kill "$STACK_PID" 2>/dev/null || true
    wait "$STACK_PID" 2>/dev/null || true
  fi
  if [ -n "${EGRESS_PID:-}" ]; then
    kill "$EGRESS_PID" 2>/dev/null || true
    wait "$EGRESS_PID" 2>/dev/null || true
  fi
  if [ "${KEEP_ENVS:-0}" = "1" ]; then
    echo "kept this run's environments and data under $TMPDIR"
  else
    rm -rf "${TMPDIR:-}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-local-development-only-not-a-real-secret-0000}"

# ── helpers ──────────────────────────────────────────────────────────────────

# A new virtual environment from a base interpreter; prints its bin directory.
new_env() { # name base-python
  "$2" -m venv "$ENVS/$1" >>"$RESULTS/venvs.log" 2>&1
  echo "$ENVS/$1/bin"
}

# The git+ source a revision's benchmark-packages.ts declares: the CLI
# (COGBENCH_SOURCE) when no constant is named, else that benchmark constant's.
pinned_source() { # revision [CONSTANT]
  local file
  file=$(git -C "$REPO_ROOT" show "$1:apps/portal/src/lib/benchmark-packages.ts")
  if [ -n "${2:-}" ]; then
    file=$(printf '%s\n' "$file" | awk -v fn="const $2" '$0 ~ fn, /^};/')
  fi
  printf '%s\n' "$file" | sed -n 's/^[[:space:]]*"git+\([^"]*\)".*$/git+\1/p' | head -1
}
commit_of() { printf '%s' "$1" | sed -n 's/.*@\([0-9a-f]\{40\}\).*/\1/p'; }

# The branch CLI, installed the documented way from this commit: pip's
# git+ reference to the checkout at SUITE_HEAD, so the install is the
# committed tree and install-pinned.sh asserts the commit pip recorded. The
# bare URL form, because pip 23 (Python 3.8's) refuses a named PEP 508
# reference to a file: URL.
BRANCH_SOURCE="git+$("$PY38" -c 'import pathlib, sys; print(pathlib.Path(sys.argv[1]).as_uri())' "$REPO_ROOT")@$SUITE_HEAD#subdirectory=python/cogbench"
install_branch_cli() { # bin label
  ./support/install-pinned.sh "$1/python" "$RESULTS/install-branch-cli-$2.log" cogworks_benchmark "$SUITE_HEAD" \
    --force-reinstall "$BRANCH_SOURCE"
}

# A benchmark distribution from a revision's pins, commit asserted.
install_benchmark() { # bin label revision CONSTANT dist[extras]
  local source commit dist_name
  source=$(pinned_source "$3" "$4")
  commit=$(commit_of "$source")
  [ -n "$commit" ] || { echo "could not read $4's git+ source from $3" >&2; return 1; }
  dist_name=${5%%\[*}
  dist_name=${dist_name//-/_}
  ./support/install-pinned.sh "$1/python" "$RESULTS/install-$2-$4.log" "$dist_name" "$commit" \
    --force-reinstall "$5 @ $source"
}

# The installed cogbench's own course track (cogbench/environment.py), the
# list `cogworks check` reports missing modules from.
install_track() { # bin label TRACK
  "$1/python" - >"$RESULTS/install-$2-$3.log" 2>&1 <<PY
import subprocess, sys

from cogbench.environment import $3

for package, _module in $3:
    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", package], check=True)
PY
}

echo "== [1/8] prerequisites =="
node --version
for py in "$PY38" "$PY311" "$PY313"; do
  "$py" -c 'import sys; print(sys.executable, sys.version.split()[0])'
done
"$PY38" -c 'import sys; assert sys.version_info[:2] == (3, 8), sys.version' \
  || { echo "PY38 must be a Python 3.8, the course's version" >&2; exit 1; }
test -f "$REPO_ROOT/apps/portal/package.json" || { echo "run from the repository" >&2; exit 1; }
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund >"$RESULTS/npm-install.log" 2>&1
fi

echo "== [2/8] fresh environments: this branch's CLI on Python 3.8, 3.11 and 3.13 =="
# week1 (3.8): the Week 1 course track and the audio benchmark from this
# commit's pins. Also the version matrix's 3.8 cell.
VENV_WEEK1=$(new_env cli-week1 "$PY38")
install_branch_cli "$VENV_WEEK1" week1
install_track "$VENV_WEEK1" week1 WEEK1_TRACK
install_benchmark "$VENV_WEEK1" week1 HEAD WEEK1_AUDIO cogworks-week1-audio-benchmark
for cell in "py311:$PY311" "py313:$PY313"; do
  name=${cell%%:*}
  bin=$(new_env "cli-$name" "${cell#*:}")
  install_branch_cli "$bin" "$name"
  install_benchmark "$bin" "$name" HEAD WEEK1_AUDIO cogworks-week1-audio-benchmark
done
VENV_PY311="$ENVS/cli-py311/bin"
VENV_PY313="$ENVS/cli-py313/bin"
"$VENV_WEEK1/cogworks" --version >"$RESULTS/cli-version.txt" 2>&1
cat "$RESULTS/cli-version.txt"
export VENV_WEEK1

echo "== [2b/8] Week 3 environment and its public data, for the live-run journey =="
VENV_WEEK3=$(new_env cli-week3 "$PY38")
install_branch_cli "$VENV_WEEK3" week3
install_track "$VENV_WEEK3" week3 WEEK3_TRACK
install_benchmark "$VENV_WEEK3" week3 HEAD WEEK3_LANGUAGE cogworks-week3-language-benchmark
export VENV_WEEK3
export WEEK3_DATA="$TMPDIR/week3-data"
mkdir -p "$WEEK3_DATA"
COGWORKS_LANGUAGE_DATA="$WEEK3_DATA" "$VENV_WEEK3/python" -m language_search_benchmark.fetch \
  >"$RESULTS/week3-data-fetch.log" 2>&1
# The check reads its working directory as the student repository: a git
# fixture holding the checked-in example submission, with a synthetic origin
# (repository_state parses it offline and never contacts it).
WEEK3_CHECK_DIR="$TMPDIR/week3-check-repo"
mkdir -p "$WEEK3_CHECK_DIR"
cp -r "$REPO_ROOT/examples/week3-language-submission/." "$WEEK3_CHECK_DIR/"
git -C "$WEEK3_CHECK_DIR" init -q
git -C "$WEEK3_CHECK_DIR" remote add origin https://github.com/cogworks-journeys/week3-language-submission.git
git -C "$WEEK3_CHECK_DIR" add -A
git -C "$WEEK3_CHECK_DIR" -c user.name=Journey -c user.email=journey-student@dev.local commit -qm "Week 3 check fixture"
(cd "$WEEK3_CHECK_DIR" && COGWORKS_LANGUAGE_DATA="$WEEK3_DATA" "$VENV_WEEK3/cogworks" check --benchmark language-search) \
  >"$RESULTS/week3-check.log" 2>&1

echo "== [3/8] fresh local D1 in this run's state directory =="
# The repo's db:migrate:local / db:seed:local commands with --persist-to added;
# pnpm run swallows appended flags, so wrangler is invoked directly.
(cd "$REPO_ROOT/apps/portal" && pnpm exec wrangler d1 migrations apply cogportal-db --local --persist-to "$SUITE_STATE" >"$RESULTS/d1-migrate.log" 2>&1)
(cd "$REPO_ROOT/apps/portal" && pnpm exec wrangler d1 execute cogportal-db --local --file scripts/seed-local.sql --persist-to "$SUITE_STATE" >"$RESULTS/d1-seed.log" 2>&1)

echo "== [4/8] production build of the portal and the bot =="
(cd "$REPO_ROOT" && pnpm --filter @cogworks/portal build >"$RESULTS/portal-build.log" 2>&1)
(cd "$REPO_ROOT/apps/discord-bot" && "$NODE24/bin/npx" wrangler deploy --dry-run --outdir dist \
  >"$RESULTS/bot-build.log" 2>&1)

echo "== [5/8] booting the local stack =="
STACK_LOG="$RESULTS/stack.log" STACK_INFO="$RESULTS/stack.json" \
  STACK_PERSIST_ROOT="$SUITE_STATE/v3" \
  node support/stack.mjs >"$RESULTS/stack-stdout.log" 2>&1 &
STACK_PID=$!
for _ in $(seq 1 180); do
  [ -f "$RESULTS/stack.json" ] && grep -q '"ready": true' "$RESULTS/stack.json" 2>/dev/null && break
  kill -0 "$STACK_PID" 2>/dev/null || { echo "stack died at boot; see $RESULTS/stack.log" >&2; exit 1; }
  sleep 1
done
grep -q '"ready": true' "$RESULTS/stack.json" || { echo "stack never became ready" >&2; exit 1; }

# Every CLI process is pinned to the booted stack's loopback origin; the run is
# refused unless it is loopback-only.
export STACK_INFO="$RESULTS/stack.json"
SUITE_PORTAL_ORIGIN=$(node -e 'const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(i.shaperPortalOrigin||""))' "$RESULTS/stack.json")
"$NODE24/bin/npx" tsx support/loopback-guard.ts "$SUITE_PORTAL_ORIGIN"
export COGPORTAL_URL="$SUITE_PORTAL_ORIGIN"
"$NODE24/bin/npx" tsx support/probe-cli-env.ts

echo "== [5.5/8] egress witness for the public-data journeys =="
# Downloads of the documented public assets are allowed and recorded; any
# other destination is refused before a socket opens and fails the case that
# attempted it (support/egress-hosts.mjs).
EGRESS_LOG="$RESULTS/egress.jsonl" EGRESS_INFO="$RESULTS/egress.json" \
  node support/egress.mjs >"$RESULTS/egress-stdout.log" 2>&1 &
EGRESS_PID=$!
for _ in $(seq 1 50); do
  [ -f "$RESULTS/egress.json" ] && break
  kill -0 "$EGRESS_PID" 2>/dev/null || { echo "egress witness died at boot; see $RESULTS/egress-stdout.log" >&2; exit 1; }
  sleep 0.2
done
[ -f "$RESULTS/egress.json" ] || { echo "egress witness never became ready" >&2; exit 1; }

echo "== [6/8] journeys (retries off; every case writes a receipt) =="
set +e
FAILED=0
for journey in setup-and-link benchmark-real-run adversarial; do
  echo "--- $journey"
  "$NODE24/bin/npx" tsx "journeys/$journey.ts" >"$RESULTS/journey-$journey.log" 2>&1
  STATUS=$?
  echo "--- $journey exited $STATUS"
  [ "$STATUS" -eq 0 ] || FAILED=1
done
# Every command on every supported Python, this branch's CLI.
for cell in "py38:$VENV_WEEK1" "py311:$VENV_PY311" "py313:$VENV_PY313"; do
  echo "--- cli-commands on ${cell%%:*}"
  CLI_LABEL="branch-${cell%%:*}" VENV_MATRIX="${cell#*:}" \
    "$NODE24/bin/npx" tsx journeys/cli-commands.ts >"$RESULTS/journey-cli-commands-${cell%%:*}.log" 2>&1
  STATUS=$?
  echo "--- cli-commands on ${cell%%:*} exited $STATUS"
  [ "$STATUS" -eq 0 ] || FAILED=1
done

echo "== [6.5/8] device-name witness =="
# python/cogbench's client sends {"deviceName": ...} to /api/v1/cli/device/start
# (client.py's start_device_link). The portal's start endpoint never reads that
# body and stores device_name as null (connections.ts:146-158). The witness
# reads the stack's own D1 row: a failed or empty read fails the run (exit 1);
# only a row read successfully with a null name is the known portal-side drop
# (exit 3), which stays on the summary without failing the run.
"$NODE24/bin/npx" tsx journeys/device-name-witness.ts >"$RESULTS/journey-device-name-witness.log" 2>&1
WITNESS_STATUS=$?
case "$WITNESS_STATUS" in
  0) echo "--- device-name witness PASSED: the portal now records the proposed device name; update the PR handoff" ;;
  3) echo "--- device-name witness: the row was read and its device_name is null (the known portal-side drop)" ;;
  *) echo "--- device-name witness could not read the authorization row (exit $WITNESS_STATUS); failing the run" >&2
     FAILED=1 ;;
esac

echo "== [7/8] both documented staging pins on every supported Python, and this commit on the week data =="
# Staging students install the CLI pinned by COGBENCH_SOURCE, and the pin
# differs per portal revision. Each pin is read from the portal revision that
# bakes it (origin/beta, origin/alpha), installed the documented way
# (python -m pip install --upgrade --force-reinstall, see
# docs/design/student-cli-and-onboarding.md) into a fresh environment per
# cell, and its commit asserted. Receipts carry the pin id, revision and source.
# The "branch" row is this commit's CLI on the Week 2 and Week 3 public-data
# journeys; its other cells are cli-commands.ts's, above.
declare -a PIN_REVISIONS=("branch:HEAD")
if git -C "$REPO_ROOT" fetch -q origin refs/heads/beta:refs/remotes/origin/beta refs/heads/alpha:refs/remotes/origin/alpha; then
  PIN_REVISIONS+=("beta:origin/beta" "alpha:origin/alpha")
else
  echo "could not fetch origin's beta and alpha revisions; the pin matrix cannot read the true pins" >&2
  FAILED=1
fi
for pin_spec in "${PIN_REVISIONS[@]}"; do
  PIN_ID="${pin_spec%%:*}"
  PIN_REV="${pin_spec##*:}"
  if [ "$PIN_ID" = branch ]; then
    PIN_SOURCE=$BRANCH_SOURCE
    PIN_SPEC=$BRANCH_SOURCE
    PIN_ENVS="week2 week3"
  else
    PIN_SOURCE=$(pinned_source "$PIN_REV")
    PIN_SPEC="cogworks-benchmark @ $PIN_SOURCE"
    PIN_ENVS="week1 week2 week3 py311 py313"
  fi
  PIN_COMMIT=$(commit_of "$PIN_SOURCE")
  if [ -z "$PIN_SOURCE" ] || [ -z "$PIN_COMMIT" ]; then
    echo "pin $PIN_ID: could not read COGBENCH_SOURCE from $PIN_REV" >&2
    FAILED=1
    continue
  fi
  for env_name in $PIN_ENVS; do
    case "$env_name" in
      py311) base="$PY311" ;;
      py313) base="$PY313" ;;
      *) base="$PY38" ;;
    esac
    cell="pin-$PIN_ID-$env_name"
    env_bin=$(new_env "$cell" "$base")
    pin_log="$RESULTS/$cell-install.log"
    if ./support/install-pinned.sh "$env_bin/python" "$pin_log" cogworks_benchmark "$PIN_COMMIT" \
      --force-reinstall "$PIN_SPEC"; then
      PIN_INSTALL_STATUS=ok
    else
      PIN_INSTALL_STATUS=failed
      FAILED=1
    fi
    export PIN_ID PIN_REV PIN_SOURCE PIN_INSTALL_STATUS
    export VENV_MATRIX="$env_bin" PIN_ENV="$env_name" PIN_INSTALL_LOG="$pin_log"
    case "$env_name" in
      week2|week3)
        # Their real-data journey scores the week's benchmark under this
        # pinned CLI; a separate small case would repeat that scored run.
        unset PIN_TEST_BENCHMARK PIN_SMALLCASE_AUDIO_STATUS PIN_SMALLCASE_AUDIO_LOG
        ;;
      *)
        # The audio benchmark from the pinned CLI's own declared source
        # (BENCHMARK_INSTALLS in the installed dist), so the cell scores a
        # real small case on its Python.
        export PIN_TEST_BENCHMARK="audio-identification"
        audio_install_log="$RESULTS/$cell-audio-install.log"
        export PIN_SMALLCASE_AUDIO_LOG="$audio_install_log"
        audio_spec=$("$env_bin/python" -c "from cogbench.plugins import BENCHMARK_INSTALLS; install = BENCHMARK_INSTALLS['audio-identification']; print(install.distribution + getattr(install, 'extras', '') + ' @ ' + install.source)" 2>>"$audio_install_log" || true)
        audio_commit=$(commit_of "$audio_spec")
        if [ -n "$audio_commit" ] && ./support/install-pinned.sh "$env_bin/python" "$audio_install_log" \
          cogworks_week1_audio_benchmark "$audio_commit" "$audio_spec"; then
          export PIN_SMALLCASE_AUDIO_STATUS=ok
        else
          export PIN_SMALLCASE_AUDIO_STATUS=failed
          FAILED=1
        fi
        ;;
    esac
    echo "--- pin $PIN_ID on $env_name: install $PIN_INSTALL_STATUS"
    if ! "$NODE24/bin/npx" tsx journeys/pin-exercise.ts >"$RESULTS/journey-$cell.log" 2>&1; then
      FAILED=1
    fi
    case "$env_name" in
      week2|week3)
        week_num=${env_name#week}
        case "$week_num" in
          2) bench_const=WEEK2_VISION; bench_spec="cogworks-week2-vision-benchmark[data]"; track_name=WEEK2_TRACK ;;
          3) bench_const=WEEK3_LANGUAGE; bench_spec="cogworks-week3-language-benchmark"; track_name=WEEK3_TRACK ;;
        esac
        # Keep git+ intact: pip follows the pinned repository only through a
        # git+ reference. Any install failure fails the run.
        if ! install_benchmark "$env_bin" "$cell" "$PIN_REV" "$bench_const" "$bench_spec"; then
          echo "pin $PIN_ID on $env_name: the week $week_num benchmark install failed; skipping its journey (the run already fails)" >&2
          FAILED=1
        else
          # The real-data journeys import each week's model stack in this
          # environment (runner.py's "FaceNet is not installed" ContractError
          # without it). The pinned cogbench's own track, never a hand-picked
          # subset that can drift from what `cogworks check` requires.
          if ! install_track "$env_bin" "$cell" "$track_name"; then
            echo "pin $PIN_ID on $env_name: the $track_name install failed; failing the run" >&2
            FAILED=1
          fi
          journey_home="$TMPDIR/homes/$cell"
          mkdir -p "$journey_home"
          if ! JOURNEY_HOME="$journey_home" EGRESS_INFO="$RESULTS/egress.json" \
            "$NODE24/bin/npx" tsx "journeys/real-data-week$week_num.ts" >"$RESULTS/journey-real-$cell.log" 2>&1; then
            FAILED=1
          fi
          rm -rf "$journey_home"
        fi
        ;;
    esac
    # The cell's environment and caches are spent; the next cell starts fresh.
    [ "${KEEP_ENVS:-0}" = "1" ] || rm -rf "$ENVS/$cell"
  done
done
unset PIN_ID PIN_REV PIN_SOURCE PIN_SPEC PIN_ENVS PIN_INSTALL_STATUS VENV_MATRIX PIN_ENV PIN_INSTALL_LOG PIN_TEST_BENCHMARK PIN_SMALLCASE_AUDIO_STATUS PIN_SMALLCASE_AUDIO_LOG

echo "== [8/8] report =="
ORCHESTRATOR_EXIT=$FAILED
if ! RESULTS_DIR="$RESULTS" node support/report.mjs; then
  echo "report/aggregation failed; failing the run" >&2
  ORCHESTRATOR_EXIT=1
fi
echo "results: $RESULTS"
exit "$ORCHESTRATOR_EXIT"
