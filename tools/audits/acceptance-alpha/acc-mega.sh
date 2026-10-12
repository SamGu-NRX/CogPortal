#!/bin/bash
exec >> /home/user/work/acc-mega.log 2>&1
set -u
date -u
REPO=/home/user/work/acc-j6
VENV=/home/user/work/acc-j6-venv/bin
RES=$REPO/tools/audits/acceptance-alpha/results
BR=obv/focus-cogportal-acceptance-alpha-20261011
if [ ! -d $REPO/.git ]; then
  git clone --depth 1 --branch alpha https://github.com/SamGu-NRX/CogPortal $REPO 2>&1 | tail -2
fi
cd $REPO
git config user.name 'Sam Gu'
git config user.email '127461594+SamGu-NRX@users.noreply.github.com'
if git fetch --depth 1 origin $BR >/dev/null 2>&1; then
  git checkout -B $BR FETCH_HEAD 2>/dev/null || git checkout $BR
else
  git checkout $BR 2>/dev/null || git checkout -b $BR
fi
if [ ! -x $VENV/python ]; then python3 -m venv /home/user/work/acc-j6-venv; fi
if ! $VENV/python -c "import cogworks_runner, modal, fastapi" 2>/dev/null; then
  $VENV/pip install -e apps/runner-modal >> /home/user/work/pip-install.log 2>&1 || echo PIP_EDITABLE_FAILED
  $VENV/pip install -q pytest >> /home/user/work/pip-install.log 2>&1
fi
$VENV/python -c "import cogworks_runner, modal, fastapi, pytest; print('IMPORT_OK')" || { echo IMPORT_FAIL; exit 1; }
pushit() {
  cd $REPO
  if git fetch --depth 1 origin $BR >/dev/null 2>&1; then
    git merge FETCH_HEAD --no-edit >> /home/user/work/merge.log 2>&1 || { echo MERGE_CONFLICT; return 1; }
  else
    echo NO_REMOTE_YET
  fi
  a=$(git log -1 --format='%an <%ae> | %cn <%ce>')
  echo "ATTRIB: $a"
  case "$a" in
    "Sam Gu <127461594+SamGu-NRX@users.noreply.github.com> | Sam Gu <127461594+SamGu-NRX@users.noreply.github.com>") ;;
    *) echo ATTRIB_FAIL; return 1 ;;
  esac
  if git push -u origin HEAD > /tmp/push.log 2>&1; then
    echo PUSH_OK
  elif [ -n "${SECRET_GITHUB_TOKEN:-}" ] && git push https://x-access-token:${SECRET_GITHUB_TOKEN}@github.com/SamGu-NRX/CogPortal.git HEAD:refs/heads/$BR >> /tmp/push.log 2>&1; then
    echo PUSH_OK_TOKEN
  else
    echo PUSH_FAILED; tail -5 /tmp/push.log; return 1
  fi
}
mkdir -p $RES
declare -A CH
CH[1]="tests/test_archive_safety.py tests/test_artifact_provenance_resources.py tests/test_benchmark_tree.py tests/test_bounded_buffer.py tests/test_callback_delivery.py tests/test_deploy_publish_phases.py tests/test_deployment_target.py tests/test_diagnostic_notes.py"
CH[2]="tests/test_environment_parity.py tests/test_evaluation_failure.py tests/test_evaluation_resource_scope.py tests/test_failure_attribution.py tests/test_failure_detail.py tests/test_forgery_corpus.py tests/test_limit_attribution.py tests/test_metric_metadata.py"
CH[3]="tests/test_official_bundle.py tests/test_prediction_validation.py tests/test_preflight_dispatch.py tests/test_prepare_attribution.py tests/test_prepare_rungs.py tests/test_prepared_environment.py tests/test_prepared_restore.py tests/test_probe_prepared_environment.py"
CH[4]="tests/test_protocol.py tests/test_refusal_forwarding.py tests/test_result_durability.py tests/test_run_python_tests.py tests/test_sandbox_cleanup.py tests/test_saved_contract_pairs.py tests/test_saved_vision_reuse.py tests/test_scorer_contract.py"
CH[5]="tests/test_smoke_reference_sandbox.py tests/test_source_copy.py tests/test_sweep_metric.py tests/test_week1_payload.py tests/test_week2_official_format.py tests/test_week2_payload.py tests/test_week3_payload.py tests/test_wiring_contract.py"
for n in 1 2 3 4 5; do
  [ -f $RES/chunk$n.done ] && continue
  echo "=== CHUNK $n start $(date -u +%H:%M:%S) ==="
  cd $REPO/apps/runner-modal
  t0=$(date +%s)
  { time $VENV/python -m pytest ${CH[$n]} -v ; } > /home/user/work/pytest-chunk$n.log 2>&1
  rc=$?
  t1=$(date +%s)
  { echo "chunk $n exit=$rc wall=$((t1-t0))s"; tail -30 /home/user/work/pytest-chunk$n.log; } > $RES/chunk$n.done
  git add tools/audits/acceptance-alpha docs/acceptance || true
  git commit -m "test(journey6): runner pytest chunk $n results" -m "Co-authored-by: obvious-autobuild[bot] <262744130+obvious-autobuild[bot]@users.noreply.github.com>" >/dev/null 2>&1 || echo NOTHING_TO_COMMIT
  pushit || echo "PUSHIT_RC=$?"
done
echo ALL_CHUNKS_DONE $(date -u)
