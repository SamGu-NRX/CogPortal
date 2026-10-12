#!/usr/bin/env bash
# Staged host preparation for the sandbox's cgroup memory/pids/cpu ceilings.
#
#   sudo -E bash tools/runner-real-journeys/stack/setup_host_cgroups.sh
#
# Creates the parent cgroup once and delegates it to uid 1000, so the suite
# can create and limit per-sandbox child cgroups without sudo on every run.
# Idempotent; touches nothing outside the parent cgroup.
set -euo pipefail

CG="${COGBOX_CG_PARENT:-/sys/fs/cgroup/cogbox}"

if [ ! -d "$CG" ]; then
  mkdir "$CG"
fi

# Let the suite user move processes into the parent and create children.
for f in cgroup.procs cgroup.threads; do
  [ -f "$CG/$f" ] && chown 1000:1000 "$CG/$f"
done
chown 1000:1000 "$CG" 2>/dev/null || true

# Enable controller delegation for child cgroups (v2: the parent must have
# no internal processes of its own for this to be allowed). The sandbox
# template writes memory.high/max, pids.max AND cpu.max into each child, so
# all three controllers must be enabled here or the cpu.max write fails.
if [ -f "$CG/cgroup.controllers" ] && [ -f "$CG/cgroup.subtree_control" ]; then
  for ctl in memory pids cpu; do
    grep -qw "$ctl" "$CG/cgroup.controllers" && echo "+$ctl" > "$CG/cgroup.subtree_control" 2>/dev/null || true
  done
fi

echo "[setup_host_cgroups] ready: $CG delegated to uid 1000"
