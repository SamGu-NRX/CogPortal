#!/bin/bash
# For the corpus operator: run one existing CLI command and retain its evidence.
# Execute only within the authorized verification phase.
set -eu
EVIDENCE=$(cd "$(dirname "$0")" && pwd)
CASE_ID=${1:?Usage: bash run-case.sh CASE_ID check|test|run}
PHASE=${2:?Usage: bash run-case.sh CASE_ID check|test|run}
case "$PHASE" in check|test|run) ;; *) echo 'Phase must be check, test, or run.' >&2; exit 64;; esac
MATCHED=0
while IFS=$'\t' read -r ID WEEK GROUP REPOSITORY SOURCE SHA SUBDIR BENCHMARK VERSION; do
  if [ "$ID" = "$CASE_ID" ]; then MATCHED=1; break; fi
done < "$EVIDENCE/cases.tsv"
[ "$MATCHED" = 1 ] || { echo "Unknown case: $CASE_ID" >&2; exit 64; }
PY=/Users/samgu/BWSI/2026/CogPortal/.venv-test/bin/python
FROZEN="$EVIDENCE/source"
RUNROOT="$EVIDENCE/local311"
CASE="$RUNROOT/work/$CASE_ID"
LOG="$RUNROOT/results/$CASE_ID/$PHASE"
mkdir -p "$RUNROOT/work" "$RUNROOT/results/$CASE_ID"
# A second invocation must not overwrite a completed or interrupted attempt.
mkdir "$LOG"
if [ ! -d "$CASE/.git" ]; then
  GIT_LFS_SKIP_SMUDGE=1 git clone --shared --no-checkout --quiet "$SOURCE" "$CASE"
  GIT_LFS_SKIP_SMUDGE=1 git -C "$CASE" checkout --quiet --detach "$SHA"
  # CLI check requires the student's GitHub identity. This edits only the copy.
  git -C "$CASE" remote set-url origin "https://github.com/$REPOSITORY.git"
fi
[ "$(git -C "$CASE" rev-parse HEAD)" = "$SHA" ] || { echo 'Case revision changed.' >&2; exit 65; }
PROJECT="$CASE/$SUBDIR"
git --no-optional-locks -C "$CASE" status --porcelain > "$LOG/git-before.txt"
printf '%s\n' "$SHA" > "$LOG/student-sha.txt"
printf '%s\n' '37b1972bbe17027256e1f5d9cf150e74193083e3' > "$LOG/evaluator-sha.txt"
printf '%s\n' "$PY -B $EVIDENCE/cli-with-cache.py $EVIDENCE/data/vision $PHASE --benchmark $BENCHMARK --json" > "$LOG/command.txt"
printf '%s\n' "$PROJECT" > "$LOG/cwd.txt"
"$PY" -I -S -c 'import sys; print(sys.version)' > "$LOG/python.txt"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$LOG/started.txt"
CODEPATH="$FROZEN/portal/python/cogbench/src:$FROZEN/week1:$FROZEN/week2:$FROZEN/week3"
LANGDATA="$EVIDENCE/data/language"
case "$PHASE:$WEEK" in
  test:2|run:2|test:3|run:3)
    # cache_status may hash data but does not download it or import student code.
    # The operator must finish the data preparation in recipe.md first.
    TIER=test; [ "$PHASE" != run ] || TIER=evaluation
    env -i HOME="$HOME" PATH="$(dirname "$PY"):/usr/bin:/bin:/opt/homebrew/bin" \
      PYTHONPATH="$CODEPATH" COGWORKS_LANGUAGE_DATA="$LANGDATA" \
      "$PY" -B -c 'import sys; from pathlib import Path; from cogbench.plugins import load_benchmark; p=load_benchmark(sys.argv[1]); s=p.cache_status(sys.argv[2],cache_root=Path(sys.argv[3])); print(s); raise SystemExit(0 if s.ready else 78)' \
      "$BENCHMARK" "$TIER" "$EVIDENCE/data/vision" > "$LOG/data-preflight.txt" 2>&1 || {
        printf '%s\n' 'blocked-prerequisite; student command not started' > "$LOG/status.txt"
        exit 78
      }
  ;;
esac
set +e
(
  cd "$PROJECT" || exit
  env -i HOME="$HOME" PATH="$(dirname "$PY"):/usr/bin:/bin:/opt/homebrew/bin" \
    PYTHONPATH="$CODEPATH" PYTHONHASHSEED=0 PYTHONDONTWRITEBYTECODE=1 \
    MPLBACKEND=Agg COGWORKS_SHOWCASE=0 MPLCONFIGDIR="$EVIDENCE/data/matplotlib" \
    NUMBA_CACHE_DIR="$EVIDENCE/data/numba" HF_HOME="$EVIDENCE/data/huggingface" \
    COGBENCH_CONFIG="$RUNROOT/unlinked-config.json" \
    COGWORKS_LANGUAGE_DATA="$LANGDATA" \
    "$PY" -B "$EVIDENCE/cli-with-cache.py" "$EVIDENCE/data/vision" "$PHASE" --benchmark "$BENCHMARK" --json
) > "$LOG/stdout.json" 2> "$LOG/stderr.log"
RC=$?
set -e
printf '%s\n' "$RC" > "$LOG/exit-code.txt"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$LOG/finished.txt"
git --no-optional-locks -C "$CASE" status --porcelain > "$LOG/git-after.txt"
if [ -d "$PROJECT/.cogbench" ]; then cp -R "$PROJECT/.cogbench" "$LOG/cogbench"; fi
# Preserve malformed stdout as evidence. Do not turn it into an invented result.
if "$PY" -I -S -m json.tool "$LOG/stdout.json" > "$LOG/parsed.json" 2> "$LOG/json-error.txt"; then
  printf '%s\n' 'json-parsed; classification requires the measurement contract' > "$LOG/status.txt"
else
  printf '%s\n' 'unparseable-output; inspect stderr and exit code' > "$LOG/status.txt"
fi
printf '%s\n' "$LOG"
exit "$RC"
