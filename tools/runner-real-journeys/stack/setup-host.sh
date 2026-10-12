#!/usr/bin/env bash
# One-time preparation for the journey rig, entirely process-local: a local
# certificate authority, server certificates for the two local hostnames, the
# suite's private hosts file, and the /workspace mountpoint.
#
#   sudo -E bash tools/runner-real-journeys/stack/setup-host.sh
#
# Nothing here changes the host's trust or name resolution: no system
# /etc/hosts edits, no update-ca-certificates. The local CA is trusted only by
# suite-started processes (stack/bootstrap.sh exports SSL_CERT_FILE,
# REQUESTS_CA_BUNDLE and NODE_EXTRA_CA_CERTS for them), and the local
# hostnames resolve only inside sandbox namespaces (the suite-private hosts
# file is bind-mounted over /etc/hosts there) and in suite processes (the
# getaddrinfo override in stack/localresolve.py). Host git and gh keep
# reaching the real GitHub.
#
# Idempotent: regenerates nothing that already exists.

set -euo pipefail

COGBOX="${COGBOX_ROOT:-/home/user/work/cogbox}"
SSL="$COGBOX/tls"
mkdir -p "$SSL"
[ -d /workspace ] || sudo -n mkdir -p /workspace

if [[ ! -f "$SSL/ca.crt" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$SSL/ca.key" -out "$SSL/ca.crt" \
    -subj "/CN=CogBox Local Journey CA" \
    -addext "basicConstraints=critical,CA:TRUE"
  echo "[setup-host] generated CA"
fi

for name in cogbox.local api.github.com; do
  if [[ ! -f "$SSL/$name.crt" ]]; then
    openssl req -newkey rsa:2048 -nodes \
      -keyout "$SSL/$name.key" -out "$SSL/$name.csr" \
      -subj "/CN=$name"
    openssl x509 -req -in "$SSL/$name.csr" \
      -CA "$SSL/ca.crt" -CAkey "$SSL/ca.key" -CAcreateserial \
      -out "$SSL/$name.crt" -days 3650 -sha256 \
      -extfile <(printf "subjectAltName=DNS:%s,IP:127.0.0.1" "$name")
    echo "[setup-host] generated server cert for $name"
  fi
done

# The suite's private hosts file, consumed by two process-local mechanisms:
# sandbox namespaces bind-mount it over /etc/hosts (stack/sandbox_shim.py),
# and suite processes get the same two names from the getaddrinfo override
# (stack/localresolve.py). It is never written to the system's /etc/hosts.
cat > "$COGBOX/hosts" <<'HOSTS'
127.0.0.1 cogbox.local
127.0.0.1 api.github.com
HOSTS
echo "[setup-host] wrote the suite-private hosts file at $COGBOX/hosts"

echo "[setup-host] done"
