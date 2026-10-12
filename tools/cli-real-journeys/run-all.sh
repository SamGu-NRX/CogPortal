#!/usr/bin/env bash
# Run every CLI and CogBot journey against the real local stack, once.
# Three consecutive invocations from clean state are the plan's M1 bar.
#
# Optional environment:
#   RUN_TAG     label grouping this run's results directory (default: run);
#               the directory itself gains a run-unique suffix per invocation
#   CONDA_ROOT  where the course environments live (default: /home/user/work/miniconda3)
#   NODE24      a Node >= 22 prefix for build tools (default: /home/user/work/node24)
#   SKIP_INSTALL=1  reuse the previously installed CLI and benchmark package
set -euo pipefail
cd "$(dirname "$0")"

# No pre-boot command talks to a portal, and nothing downstream may inherit a
# caller's COGPORTAL_URL: the real origin is resolved from the booted stack
# after step 5, guarded, and re-exported there.
unset COGPORTAL_URL

REPO_ROOT=$(cd ../.. && pwd)
CONDA_ROOT=${CONDA_ROOT:-/home/user/work/miniconda3}
NODE24=${NODE24:-/home/user/work/node24}
WEEK1_ENV="$CONDA_ROOT/envs/week1"
WEEK3_ENV="$CONDA_ROOT/envs/week3"
export PATH="$NODE24/bin:$PATH"
RUN_TAG=${RUN_TAG:-run}
# Unique per invocation (support/state-dir.sh): the results directory - and
# with it the D1 state root below - is fresh even when RUN_TAG repeats, so a
# reused tag can never re-migrate over, or judge against, another run's D1.
RESULTS=$(bash support/state-dir.sh "$PWD/results" "$RUN_TAG")
echo "results directory: $RESULTS"
# This run's own persistence directory: the wrangler migrate and seed steps
# and the booted stack keep their state here (wrangler's v3 layout), never in
# the checkout's .wrangler state. Exported: the device-name witness reads the
# stack's D1 through the same persistence root.
export SUITE_STATE="$RESULTS/state"
mkdir -p "$RESULTS/receipts"
# Per-run scratch space for the helpers' mkdtemp calls (CLI homes, the git
# fixture, the spawn probe). It cannot live under RESULTS: tsx binds its IPC
# pipes as unix sockets under TMPDIR with the pid in the name, and a path
# through this checkout's results directory passes the 108-byte unix-socket
# limit and dies with EADDRINUSE. /tmp keeps the path short; the run-unique
# suffix keeps it scoped to this run, and the EXIT trap below removes it.
export TMPDIR="/tmp/cli-real-journeys-${RUN_TAG}-$(date -u +%H%M%SZ)-$$"
mkdir -p "$TMPDIR"
export RESULTS_DIR="$RESULTS"
# Any early exit - a failing step under set -e, or INT/TERM - must not leave
# the booted stack or this run's scratch state behind. STACK_PID is set when
# the stack boots; this trap is the only place that stops it. It preserves
# the exit status it fires with.
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
  rm -rf "${TMPDIR:-}" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# The journeys mint dev sessions and read the setup page's check-off secret; it
# must be the same value the booted Worker runs with.
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-local-development-only-not-a-real-secret-0000}"
export VENV_WEEK1="$WEEK1_ENV/bin"  # CliHome wants the venv's bin directory
export VENV_WEEK3="$WEEK3_ENV/bin"  # the live-run journey's Week 3 CLI home
# The live-run journey pins the Week 3 data root at the suite's own ignored
# copy of the artifacts, fetched once by stage 2b.
export WEEK3_DATA="$PWD/.week3-data"

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

echo "== [2b/8] Week 3 environment and pinned data for the live-run journey =="
# The successful --live journey runs the real language-search benchmark from
# the Week 3 environment: it installs the CLI and the Week 3 distribution the
# student way, fetches the checksum-pinned public artifacts once into the
# suite's own ignored directory, and proves `cogworks check` passes against
# them before any journey depends on that.
if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  # The CLI's own WEEK3_TRACK (cogbench/environment.py, citing the course's
  # docs) is the authoritative stack for this environment - the check step
  # below verifies every module on it. Install from that spec rather than a
  # hand-picked subset, so the suite cannot drift from what the check
  # requires. cogbench goes in first so its track list can be read here.
  "$WEEK3_ENV/bin/python" -m pip install --quiet -e "$REPO_ROOT/python/cogbench" \
    >"$RESULTS/pip-week3-cli.log" 2>&1
  "$WEEK3_ENV/bin/python" - <<'PY' >"$RESULTS/pip-week3-deps.log" 2>&1
import subprocess
import sys

from cogbench.environment import WEEK3_TRACK

for package, _module in WEEK3_TRACK:
    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", package], check=True)
PY
  "$WEEK3_ENV/bin/python" -m pip install --quiet -e "$REPO_ROOT/benchmarks/week3" \
    >"$RESULTS/pip-week3-bench.log" 2>&1
fi
mkdir -p "$WEEK3_DATA"
COGWORKS_LANGUAGE_DATA="$WEEK3_DATA" "$WEEK3_ENV/bin/python" -m language_search_benchmark.fetch \
  >"$RESULTS/week3-data-fetch.log" 2>&1
# The check inspects its working directory as the student repository, so run
# it in a throwaway git fixture holding the checked-in example submission.
WEEK3_CHECK_DIR="$RESULTS/week3-check-repo"
rm -rf "$WEEK3_CHECK_DIR" && mkdir -p "$WEEK3_CHECK_DIR"
cp -r "$REPO_ROOT/examples/week3-language-submission/." "$WEEK3_CHECK_DIR/"
git -C "$WEEK3_CHECK_DIR" init -q
# The check requires repositoryFullName (cli.py's required list): a fixture
# without an `origin` remote always exits 2. repository_state parses the URL
# offline - never contacts it - so a synthetic course-repo URL keeps the
# fixture hermetic while satisfying the check's metadata requirement.
git -C "$WEEK3_CHECK_DIR" remote add origin https://github.com/cogworks-journeys/week3-language-submission.git
git -C "$WEEK3_CHECK_DIR" add -A
git -C "$WEEK3_CHECK_DIR" -c user.name=Journey -c user.email=journey-student@dev.local commit -qm "Week 3 check fixture"
(cd "$WEEK3_CHECK_DIR" && COGWORKS_LANGUAGE_DATA="$WEEK3_DATA" "$WEEK3_ENV/bin/cogworks" check --benchmark language-search) \
  >"$RESULTS/week3-check.log" 2>&1

echo "== [3/7] fresh local D1 in this run's state directory =="
# The repo's db:migrate:local / db:seed:local scripts with the per-run
# persistence root appended. pnpm run swallows appended flags (probed on
# 9.15.9: the checkout's default state was used and the probe dir stayed
# empty), so the wrangler commands are invoked directly: the same commands
# the scripts run, with --persist-to added.
(cd "$REPO_ROOT/apps/portal" && pnpm exec wrangler d1 migrations apply cogportal-db --local --persist-to "$SUITE_STATE" >"$RESULTS/d1-migrate.log" 2>&1)
(cd "$REPO_ROOT/apps/portal" && pnpm exec wrangler d1 execute cogportal-db --local --file scripts/seed-local.sql --persist-to "$SUITE_STATE" >"$RESULTS/d1-seed.log" 2>&1)

echo "== [4/7] production build of the portal and the bot =="
(cd "$REPO_ROOT" && pnpm --filter @cogworks/portal build >"$RESULTS/portal-build.log" 2>&1)
(cd "$REPO_ROOT/apps/discord-bot" && "$NODE24/bin/npx" wrangler deploy --dry-run --outdir dist \
  >"$RESULTS/bot-build.log" 2>&1)

echo "== [5/7] booting the local stack =="
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
cat "$RESULTS/stack.json"

# The suite dials nothing but the booted local stack. Resolve the origin every
# CLI process will be pinned to, refuse the run unless it is loopback-only,
# then export it, overriding anything the caller's environment had set.
export STACK_INFO="$RESULTS/stack.json"
SUITE_PORTAL_ORIGIN=$(node -e 'const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(i.shaperPortalOrigin||""))' "$RESULTS/stack.json")
"$NODE24/bin/npx" tsx support/loopback-guard.ts "$SUITE_PORTAL_ORIGIN"
export COGPORTAL_URL="$SUITE_PORTAL_ORIGIN"
# Probe: a CLI subprocess spawned the way the journeys spawn them must see
# the pinned loopback origin, not an inherited value.
"$NODE24/bin/npx" tsx support/probe-cli-env.ts

echo "== [5.5/8] egress witness for the public-data journeys =="
# The week 2/3 real-data journeys route the CLI through this proxy: downloads
# of the documented public assets are allowed and recorded (host, bytes), and
# any other traffic an offline command attempts is refused and logged, which
# is exactly the defect the journeys exist to catch. The EXIT trap stops it.
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

echo "== [6/7] journeys (retries off; every case writes a receipt) =="
set +e
FAILED=0
for journey in setup-and-link benchmark-real-run adversarial; do
  echo "--- $journey"
  "$NODE24/bin/npx" tsx "journeys/$journey.ts" >"$RESULTS/journey-$journey.log" 2>&1
  STATUS=$?
  echo "--- $journey exited $STATUS"
  [ "$STATUS" -eq 0 ] || FAILED=1
done
set -e

echo "== [6.5/8] device-name witness (expected failing; tracked in the PR handoff) =="
# python/cogbench's client sends {"deviceName": ...} to /api/v1/cli/device/start
# so the registration payload proposes the device's name (client.py's
# start_device_link). The portal's start endpoint never reads that body and
# stores device_name as null - the proposal is dropped. This suite owns no
# portal files, so the witness proves the drop with the stack's own D1 row
# and is deliberately non-required: while the portal drops the name, its
# receipt stays FAIL (visible in the report's witness line) but the run bar
# stays green and the PR handoff carries the portal-side item for the web
# owner. If this witness ever passes, the portal records the proposal and
# the handoff item can be closed.
if ! "$NODE24/bin/npx" tsx journeys/device-name-witness.ts \
  >"$RESULTS/journey-device-name-witness.log" 2>&1; then
  echo "--- device-name witness FAILS as expected (the portal's start endpoint ignores the proposed device name; tracked for the web owner)"
else
  echo "--- device-name witness PASSED: the portal now records the proposed device name; update the PR handoff"
fi

echo "== [7/8] both documented staging pins, on every supported Python =="
# Staging students install the CLI pinned by COGBENCH_SOURCE, and the pin
# differs per portal revision: the beta revision's copy of benchmark-packages.ts
# and the alpha revision's each name their own CLI commit. Read every pin from
# the portal revision that bakes it — the branch tip, fetched fresh, never a
# CLI commit reused as a revision (that wiring once resolved the beta label to
# 71e4767 and the alpha label to 064400e9, so alpha's real pin ecae6171521d
# was never installed) — then install it the documented way (python -m pip
# install --upgrade --force-reinstall, docs/design/student-cli-and-onboarding.md)
# into every supported environment and exercise it there. The receipts carry
# the pin id, the revision and the resolved source, so a matrix cell can never
# be mistaken for another's.
declare -a PIN_REVISIONS=()
if git -C "$REPO_ROOT" fetch origin refs/heads/beta:refs/remotes/origin/beta refs/heads/alpha:refs/remotes/origin/alpha; then
  PIN_REVISIONS=("beta:origin/beta" "alpha:origin/alpha")
else
  echo "could not fetch origin's beta and alpha revisions; the pin matrix cannot read the true pins" >&2
  FAILED=1
fi
# week1/week2/week3 are the course's Python 3.8 environments; py311 and py313
# are the other supported versions the course documents (the hosted runner's
# shared image is 3.11; the 3.8 runners are baked venvs).
declare -a PIN_ENVS=("week1" "week2" "week3" "py311" "py313")
for pin_spec in "${PIN_REVISIONS[@]}"; do
  PIN_ID="${pin_spec%%:*}"
  PIN_REV="${pin_spec##*:}"
  PIN_SOURCE=$(git -C "$REPO_ROOT" show "$PIN_REV:apps/portal/src/lib/benchmark-packages.ts" \
    | sed -n 's/^[[:space:]]*"git+\([^"]*\)".*$/git+\1/p' | head -1)
  PIN_COMMIT=$(printf '%s' "$PIN_SOURCE" | sed -n 's/.*@\([0-9a-f]\{40\}\).*/\1/p')
  if [ -z "$PIN_SOURCE" ] || [ -z "$PIN_COMMIT" ]; then
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
    elif ./support/install-pinned.sh "$env_bin/python" "$pin_log" "cogworks_benchmark" "$PIN_COMMIT" \
      --force-reinstall "cogworks-benchmark @ $PIN_SOURCE"; then
      PIN_INSTALL_STATUS=ok
    else
      PIN_INSTALL_STATUS=failed
    fi
    export PIN_ID PIN_REV PIN_SOURCE PIN_INSTALL_STATUS
    export VENV_MATRIX="$env_bin" PIN_ENV="$env_name" PIN_INSTALL_LOG="$pin_log"
    # Small cases per environment: week 1 runs its pre-baked audio benchmark;
    # the version-matrix environments (py311, py313) first get that benchmark
    # installed from the pinned CLI's own declared source (BENCHMARK_INSTALLS
    # in the installed dist), so their cells exercise a real scored run on
    # their real Python too. Week 2/3 cells export no benchmark: their
    # real-data journey scores the week's benchmark under this same pinned
    # CLI and those receipts carry the pin — a separate small case would only
    # repeat that scored run, so no receipt is written for it here.
    case "$env_name" in
      week2|week3)
        unset PIN_TEST_BENCHMARK PIN_SMALLCASE_AUDIO_STATUS PIN_SMALLCASE_AUDIO_LOG
        ;;
      week1)
        export PIN_TEST_BENCHMARK="audio-identification"
        export PIN_SMALLCASE_AUDIO_STATUS=prebaked
        ;;
      *)
        export PIN_TEST_BENCHMARK="audio-identification"
        audio_install_log="$RESULTS/pin-$PIN_ID-$env_name-audio-install.log"
        export PIN_SMALLCASE_AUDIO_LOG="$audio_install_log"
        if "$env_bin/python" -c "import importlib.metadata as m; m.version('cogworks-week1-audio-benchmark')" 2>/dev/null; then
          export PIN_SMALLCASE_AUDIO_STATUS=prebaked
        else
          audio_spec=$("$env_bin/python" -c "from cogbench.plugins import BENCHMARK_INSTALLS; install = BENCHMARK_INSTALLS['audio-identification']; print(install.distribution + install.extras + ' @ ' + install.source)")
          audio_commit=$(printf '%s' "$audio_spec" | sed -n 's/.*@\([0-9a-f]\{40\}\).*/\1/p')
          if [ -n "$audio_commit" ] && ./support/install-pinned.sh "$env_bin/python" "$audio_install_log" \
            "cogworks_week1_audio_benchmark" "$audio_commit" "$audio_spec"; then
            export PIN_SMALLCASE_AUDIO_STATUS=ok
          else
            export PIN_SMALLCASE_AUDIO_STATUS=failed
          fi
        fi
        ;;
    esac
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
        # Keep git+ intact: pip can only follow the pinned repository through
        # a git+ direct reference — a bare https URL is treated as an archive
        # download and fails (the stripped form once made every one of these
        # installs fail silently). install-pinned.sh asserts the installed
        # dist's commit is the pinned one, and any install failure fails the
        # run here — never a swallowed exit code.
        bench_source=$(git -C "$REPO_ROOT" show "$PIN_REV:apps/portal/src/lib/benchmark-packages.ts" \
          | awk -v fn="const $bench_fn" '$0 ~ fn, /^};/' \
          | sed -n 's/^[[:space:]]*"git+\([^"]*\)".*$/git+\1/p' | head -1)
        bench_commit=$(printf '%s' "$bench_source" | sed -n 's/.*@\([0-9a-f]\{40\}\).*/\1/p')
        bench_dist_name=${bench_dist//-/_}
        bench_log="$RESULTS/pin-$PIN_ID-$env_name-benchmark-install.log"
        bench_status=failed
        if [ -z "$bench_source" ] || [ -z "$bench_commit" ]; then
          echo "pin $PIN_ID on $env_name: could not read $bench_fn's git+ source from $PIN_REV" >&2
          FAILED=1
        elif ./support/install-pinned.sh "$env_bin/python" "$bench_log" "$bench_dist_name" "$bench_commit" \
          --force-reinstall "$bench_dist$bench_extra @ $bench_source"; then
          bench_status=ok
        else
          echo "pin $PIN_ID on $env_name: the week $week_num benchmark install failed; failing the run (log: $bench_log)" >&2
          FAILED=1
        fi
        echo "--- pin $PIN_ID on $env_name: benchmark install $bench_status"
        if [ "$bench_status" != "ok" ]; then
          echo "--- pin $PIN_ID on $env_name: skipping the week $week_num real-data journey; the week's benchmark did not install (the run already fails)" >&2
          continue
        fi
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
unset PIN_ID PIN_REV PIN_SOURCE PIN_INSTALL_STATUS VENV_MATRIX PIN_ENV PIN_INSTALL_LOG PIN_TEST_BENCHMARK PIN_SMALLCASE_AUDIO_STATUS PIN_SMALLCASE_AUDIO_LOG

echo "== [8/8] report =="
# A failing report/aggregation step must fail the run, not be swallowed:
# the summary is the operator's evidence of record.
ORCHESTRATOR_EXIT=$FAILED
if ! RESULTS_DIR="$RESULTS" node support/report.mjs; then
  echo "report/aggregation failed; failing the run" >&2
  ORCHESTRATOR_EXIT=1
fi
echo "results: $RESULTS"
exit "$ORCHESTRATOR_EXIT"
