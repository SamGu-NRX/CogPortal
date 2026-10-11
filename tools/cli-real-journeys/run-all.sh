#!/usr/bin/env bash
# Run every CLI and CogBot journey against the real local stack, once.
# Three consecutive invocations from clean state are the plan's M1 bar.
#
# Optional environment:
#   RUN_TAG     label for this run's results directory (default: timestamp)
#   CONDA_ROOT  where the course environments live (default: /home/user/work/miniconda3)
#   NODE24      a Node >= 24 prefix (default: /home/user/work/node24)
set -euo pipefail
cd "$(dirname "$0")"

REPO_ROOT=$(cd ../.. && pwd)
CONDA_ROOT=${CONDA_ROOT:-/home/user/work/miniconda3}
NODE24=${NODE24:-/home/user/work/node24}
export PATH="$NODE24/bin:$PATH"
RUN_TAG=${RUN_TAG:-$(date -u +%Y%m%dT%H%M%SZ)}
RESULTS="$PWD/results/$RUN_TAG"
mkdir -p "$RESULTS"

echo "== [1/6] prerequisites =="
node --version
if [ ! -d "$CONDA_ROOT/envs/week1" ]; then
  echo "conda env week1 missing; run-all.sh creates course envs on first use" >&2
  bash "$REPO_ROOT/tools/cli-real-journeys/py/bootstrap-course-envs.sh"
fi
for env in week1 week2 week3 py311 py313; do
  test -d "$CONDA_ROOT/envs/$env" || { echo "missing conda env: $env" >&2; exit 1; }
done
test -f "$REPO_ROOT/apps/portal/package.json" || { echo "run from the repository" >&2; exit 1; }
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund >"$RESULTS/npm-install.log" 2>&1
fi
npx playwright install chromium >"$RESULTS/playwright-install.log" 2>&1 || true

echo "== [2/6] fresh local D1 (repo's own dev path) =="
rm -rf "$REPO_ROOT/apps/portal/.wrangler/state"
(cd "$REPO_ROOT/apps/portal" && pnpm db:migrate:local >"$RESULTS/d1-migrate.log" 2>&1)
(cd "$REPO_ROOT/apps/portal" && pnpm db:seed:local >"$RESULTS/d1-seed.log" 2>&1)

echo "== [3/6] production build of the portal =="
(cd "$REPO_ROOT" && pnpm --filter @cogworks/portal build >"$RESULTS/portal-build.log" 2>&1)

echo "== [4/6] booting the local stack =="
STACK_LOG="$RESULTS/stack.log" STACK_INFO="$RESULTS/stack.json" \
  node support/stack.mjs >"$RESULTS/stack-stdout.log" 2>&1 &
STACK_PID=$!
for _ in $(seq 1 120); do
  [ -f "$RESULTS/stack.json" ] && grep -q ready "$RESULTS/stack.json" 2>/dev/null && break
  kill -0 "$STACK_PID" 2>/dev/null || { echo "stack died at boot; see $RESULTS/stack.log" >&2; exit 1; }
  sleep 1
done
cat "$RESULTS/stack.json"

echo "== [5/6] journeys (retries off) =="
set +e
PLAYWRIGHT_JSON_OUTPUT_NAME="$RESULTS/journeys.json" \
  npx playwright test "$@" --reporter=list,json >"$RESULTS/playwright.log" 2>&1
STATUS=$?
set -e

echo "== [6/6] report =="
PLAYWRIGHT_JSON="$RESULTS/journeys.json" RESULTS_DIR="$RESULTS" node support/report.mjs || true
kill "$STACK_PID" 2>/dev/null || true
wait "$STACK_PID" 2>/dev/null || true
echo "results: $RESULTS"
exit $STATUS
