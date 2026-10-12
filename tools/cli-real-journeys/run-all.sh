#!/usr/bin/env bash
# Run every CLI and CogBot journey against the real local stack, once.
# Three consecutive invocations from clean state are the plan's M1 bar.
#
# Optional environment:
#   RUN_TAG     label for this run's results directory (default: timestamp)
#   CONDA_ROOT  where the course environments live (default: /home/user/work/miniconda3)
#   NODE24      a Node >= 22 prefix for build tools (default: /home/user/work/node24)
#   SKIP_INSTALL=1  reuse the previously installed CLI and benchmark package
set -euo pipefail
cd "$(dirname "$0")"

REPO_ROOT=$(cd ../.. && pwd)
CONDA_ROOT=${CONDA_ROOT:-/home/user/work/miniconda3}
NODE24=${NODE24:-/home/user/work/node24}
WEEK1_ENV="$CONDA_ROOT/envs/week1"
export PATH="$NODE24/bin:$PATH"
RUN_TAG=${RUN_TAG:-$(date -u +%Y%m%dT%H%M%SZ)}
RESULTS="$PWD/results/$RUN_TAG"
mkdir -p "$RESULTS"
export RESULTS_DIR="$RESULTS"
# The journeys mint dev sessions and read the setup page's check-off secret; it
# must be the same value the booted Worker runs with.
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-local-development-only-not-a-real-secret-0000}"
export VENV_WEEK1="$WEEK1_ENV/bin"  # CliHome wants the venv's bin directory

echo "== [1/7] prerequisites =="
node --version
test -f "$REPO_ROOT/apps/portal/package.json" || { echo "run from the repository" >&2; exit 1; }
test -d "$WEEK1_ENV" || { echo "conda env week1 missing; run py/bootstrap-course-envs.sh first" >&2; exit 1; }
if [ ! -d node_modules ]; then
  corepack enable >/dev/null 2>&1 || true
  npm install --no-audit --no-fund >"$RESULTS/npm-install.log" 2>&1
fi

echo "== [2/7] install the real CLI and the week1 benchmark (student commands) =="
if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  "$WEEK1_ENV/bin/python" -m pip install --quiet "numpy==1.24.4" \
    >"$RESULTS/pip-deps.log" 2>&1
  "$WEEK1_ENV/bin/python" -m pip install --quiet scipy soundfile librosa ipython matplotlib \
    >>"$RESULTS/pip-deps.log" 2>&1
  "$WEEK1_ENV/bin/python" -m pip install --quiet -e "$REPO_ROOT/python/cogbench" \
    >>"$RESULTS/pip-cli.log" 2>&1
  "$WEEK1_ENV/bin/python" -m pip install --quiet -e "$REPO_ROOT/benchmarks/week1" \
    >>"$RESULTS/pip-week1.log" 2>&1
fi
"$WEEK1_ENV/bin/cogworks" --version >"$RESULTS/cli-version.txt" 2>&1
cat "$RESULTS/cli-version.txt"

echo "== [3/7] fresh local D1 (repo's own dev path) =="
rm -rf "$REPO_ROOT/apps/portal/.wrangler/state"
(cd "$REPO_ROOT/apps/portal" && pnpm db:migrate:local >"$RESULTS/d1-migrate.log" 2>&1)
(cd "$REPO_ROOT/apps/portal" && pnpm db:seed:local >"$RESULTS/d1-seed.log" 2>&1)

echo "== [4/7] production build of the portal and the bot =="
(cd "$REPO_ROOT" && pnpm --filter @cogworks/portal build >"$RESULTS/portal-build.log" 2>&1)
(cd "$REPO_ROOT/apps/discord-bot" && "$NODE24/bin/npx" wrangler deploy --dry-run --outdir dist \
  >"$RESULTS/bot-build.log" 2>&1)

echo "== [5/7] booting the local stack =="
STACK_LOG="$RESULTS/stack.log" STACK_INFO="$RESULTS/stack.json" \
  node support/stack.mjs >"$RESULTS/stack-stdout.log" 2>&1 &
STACK_PID=$!
for _ in $(seq 1 180); do
  [ -f "$RESULTS/stack.json" ] && grep -q '"ready": true' "$RESULTS/stack.json" 2>/dev/null && break
  kill -0 "$STACK_PID" 2>/dev/null || { echo "stack died at boot; see $RESULTS/stack.log" >&2; exit 1; }
  sleep 1
done
grep -q '"ready": true' "$RESULTS/stack.json" || { echo "stack never became ready" >&2; exit 1; }
cat "$RESULTS/stack.json"

echo "== [5.5/8] egress witness for the public-data journeys =="
# The week 2/3 real-data journeys route the CLI through this proxy: downloads
# of the documented public assets are allowed and recorded (host, bytes), and
# any other traffic an offline command attempts is refused and logged, which
# is exactly the defect the journeys exist to catch.
EGRESS_LOG="$RESULTS/egress.jsonl" EGRESS_INFO="$RESULTS/egress.json" \
  node support/egress.mjs >"$RESULTS/egress-stdout.log" 2>&1 &
EGRESS_PID=$!
for _ in $(seq 1 50); do
  [ -f "$RESULTS/egress.json" ] && break
  kill -0 "$EGRESS_PID" 2>/dev/null || { echo "egress witness died at boot; see $RESULTS/egress-stdout.log" >&2; exit 1; }
  sleep 0.2
done
[ -f "$RESULTS/egress.json" ] || { echo "egress witness never became ready" >&2; exit 1; }
cat "$RESULTS/egress.json"

echo "== [6/8] journeys (retries off; every case writes a receipt) =="
set +e
export STACK_INFO="$RESULTS/stack.json"
FAILED=0
for journey in setup-and-link benchmark-real-run adversarial; do
  echo "--- $journey"
  "$NODE24/bin/npx" tsx "journeys/$journey.ts" >"$RESULTS/journey-$journey.log" 2>&1
  STATUS=$?
  echo "--- $journey exited $STATUS"
  [ "$STATUS" -eq 0 ] || FAILED=1
done
set -e

echo "== [7/8] both documented staging pins, on every supported Python =="
# Staging students install the CLI pinned by COGBENCH_SOURCE, and the pin
# differs per environment: each staging copy of benchmark-packages.ts names
# its own CLI commit. Read every pin from the revision that bakes it — never
# from the working tree — then install it the documented way (python -m pip
# install --upgrade --force-reinstall, docs/design/student-cli-and-onboarding.md)
# into every supported environment and exercise it there. The receipts carry
# the pin id, so a matrix cell can never be mistaken for another's.
declare -a PIN_REVISIONS=("beta:064400e9cf65874b87fe888fc6fd14a564095c5e" "alpha:ecae6171521d")
# week1/week2/week3 are the course's Python 3.8 environments; py311 and py313
# are the other supported versions the course documents (the hosted runner's
# shared image is 3.11; the 3.8 runners are baked venvs).
declare -a PIN_ENVS=("week1" "week2" "week3" "py311" "py313")
for pin_spec in "${PIN_REVISIONS[@]}"; do
  PIN_ID="${pin_spec%%:*}"
  PIN_REV="${pin_spec##*:}"
  PIN_SOURCE=$(git -C "$REPO_ROOT" show "$PIN_REV:apps/portal/src/lib/benchmark-packages.ts" \
    | sed -n 's/^[[:space:]]*"git+\([^"]*\)".*$/git+\1/p' | head -1)
  if [ -z "$PIN_SOURCE" ]; then
    echo "pin $PIN_ID: could not read COGBENCH_SOURCE from $PIN_REV" >&2
    FAILED=1
    continue
  fi
  for env_name in "${PIN_ENVS[@]}"; do
    env_bin="$CONDA_ROOT/envs/$env_name/bin"
    pin_log="$RESULTS/pin-$PIN_ID-$env_name-install.log"
    if [ ! -x "$env_bin/python" ]; then
      PIN_INSTALL_STATUS=missing
      : >"$pin_log"
    elif "$env_bin/python" -m pip install --quiet --upgrade --force-reinstall \
      "cogworks-benchmark @ $PIN_SOURCE" >"$pin_log" 2>&1; then
      PIN_INSTALL_STATUS=ok
    else
      PIN_INSTALL_STATUS=failed
      tail -5 "$pin_log" >&2
    fi
    export PIN_ID PIN_REV PIN_SOURCE PIN_INSTALL_STATUS
    export VENV_MATRIX="$env_bin" PIN_ENV="$env_name" PIN_INSTALL_LOG="$pin_log"
    if [ "$env_name" = "week1" ]; then
      export PIN_TEST_BENCHMARK="audio-identification"
    else
      export PIN_TEST_BENCHMARK=""
    fi
    echo "--- pin $PIN_ID on $env_name: install $PIN_INSTALL_STATUS"
    if ! "$NODE24/bin/npx" tsx journeys/pin-exercise.ts \
      >"$RESULTS/journey-pin-$PIN_ID-$env_name.log" 2>&1; then
      FAILED=1
    fi
    # The week 2/3 public-data journeys run against the pinned CLI too, with
    # the week's benchmark distribution installed from the same pinned copy
    # of benchmark-packages.ts, so a receipt's pin label is the whole story.
    case "$env_name" in
      week2|week3)
        week_num=${env_name#week}
        case "$week_num" in
          2) bench_dist="cogworks-week2-vision-benchmark"; bench_extra="[data]"; bench_fn="WEEK2_VISION" ;;
          3) bench_dist="cogworks-week3-language-benchmark"; bench_extra=""; bench_fn="WEEK3_LANGUAGE" ;;
        esac
        bench_source=$(git -C "$REPO_ROOT" show "$PIN_REV:apps/portal/src/lib/benchmark-packages.ts" \
          | awk -v fn="const $bench_fn" '$0 ~ fn, /^};/' \
          | sed -n 's/^.*"git+\([^"]*\)".*$/\1/p' | head -1)
        bench_log="$RESULTS/pin-$PIN_ID-$env_name-benchmark-install.log"
        bench_status=missing
        if [ -n "$bench_source" ] && "$env_bin/python" -m pip install --quiet \
          "$bench_dist$bench_extra @ $bench_source" >"$bench_log" 2>&1; then
          bench_status=ok
        else
          tail -5 "$bench_log" >&2
        fi
        echo "--- pin $PIN_ID on $env_name: benchmark install $bench_status"
        journey_home="$RESULTS/journey-home-$PIN_ID-$env_name"
        rm -rf "$journey_home"
        mkdir -p "$journey_home"
        export JOURNEY_HOME="$journey_home"
        export EGRESS_INFO="$RESULTS/egress.json"
        if ! "$NODE24/bin/npx" tsx "journeys/real-data-week$week_num.ts" \
          >"$RESULTS/journey-real-$PIN_ID-$env_name.log" 2>&1; then
          FAILED=1
        fi
        unset JOURNEY_HOME EGRESS_INFO
        ;;
    esac
  done
done
unset PIN_ID PIN_REV PIN_SOURCE PIN_INSTALL_STATUS VENV_MATRIX PIN_ENV PIN_INSTALL_LOG PIN_TEST_BENCHMARK

echo "== [8/8] report =="
kill "$STACK_PID" 2>/dev/null || true
kill "${EGRESS_PID:-}" 2>/dev/null || true
wait "$STACK_PID" 2>/dev/null || true
wait "${EGRESS_PID:-}" 2>/dev/null || true
RESULTS_DIR="$RESULTS" node support/report.mjs || true
echo "results: $RESULTS"
exit "$FAILED"
