#!/usr/bin/env bash
# Suite entry point: prepares the process-local trust material, then starts
# the edge and the runner. Every process started from here inherits an env in
# which only the suite trusts the local CA and resolves the local hostnames;
# host git and gh keep using the system resolver and the real GitHub.
#
#   bash tools/runner-real-journeys/stack/bootstrap.sh
#
# Idempotent: safe to re-run; stops stack processes it started before
# (pidfiles under COGBOX_ROOT/logs) before starting new ones.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
export COGBOX_ROOT="${COGBOX_ROOT:-/home/user/work/cogbox}"
export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"

# One-time prep: local CA + server certs + the suite-private hosts file.
bash "$HERE/setup-host.sh"

# Process-local trust: ONLY suite-started processes see these variables. The
# system trust store is never modified, so host git/gh keep reaching the real
# GitHub (their own credential and CA configuration is untouched).
export SSL_CERT_FILE="$COGBOX_ROOT/tls/ca.crt"
export REQUESTS_CA_BUNDLE="$COGBOX_ROOT/tls/ca.crt"
export NODE_EXTRA_CA_CERTS="$COGBOX_ROOT/tls/ca.crt"

mkdir -p "$COGBOX_ROOT/logs"

stop_stale() {
  local pidfile="$1" pid
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.3
    fi
    rm -f "$pidfile"
  fi
}
stop_stale "$COGBOX_ROOT/logs/edge.pid"
stop_stale "$COGBOX_ROOT/logs/runnerbox.pid"

echo "[bootstrap] starting the edge (cogbox.local + api.github.com) on :443"
python3 "$HERE/edge.py" --port 443 --upstream 127.0.0.1:5175 \
  >>"$COGBOX_ROOT/logs/edge.log" 2>&1 &
edge_pid=$!
sleep 0.5
if ! kill -0 "$edge_pid" 2>/dev/null; then
  echo "[bootstrap] unprivileged bind of :443 failed — retrying with sudo"
  sudo -E python3 "$HERE/edge.py" --port 443 --upstream 127.0.0.1:5175 \
    >>"$COGBOX_ROOT/logs/edge.log" 2>&1 &
  edge_pid=$!
fi
echo "$edge_pid" > "$COGBOX_ROOT/logs/edge.pid"

echo "[bootstrap] starting the runner (real controller) on :8791"
python3 "$HERE/runnerbox.py" serve --port 8791 --repo "$REPO" \
  >>"$COGBOX_ROOT/logs/runnerbox.log" 2>&1 &
echo $! > "$COGBOX_ROOT/logs/runnerbox.pid"

echo "[bootstrap] edge pid $(cat "$COGBOX_ROOT/logs/edge.pid"), runner pid $(cat "$COGBOX_ROOT/logs/runnerbox.pid")"
echo "[bootstrap] trust scope: suite processes only (SSL_CERT_FILE/REQUESTS_CA_BUNDLE/NODE_EXTRA_CA_CERTS)"
echo "[bootstrap] done"
