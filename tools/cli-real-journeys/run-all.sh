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
  "$WEEK1_ENV/bin/python" -m pip install --quiet scipy soundfile librosa \
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

echo "== [6/7] journeys (retries off; every case writes a receipt) =="
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

echo "== [7/7] report =="
kill "$STACK_PID" 2>/dev/null || true
wait "$STACK_PID" 2>/dev/null || true
RESULTS_DIR="$RESULTS" node support/report.mjs || true
echo "results: $RESULTS"
exit "$FAILED"
