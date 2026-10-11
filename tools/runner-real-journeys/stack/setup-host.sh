#!/usr/bin/env bash
# One-time host preparation for the journey rig: a local certificate
# authority trusted system-wide, server certificates for the two local
# hostnames, /etc/hosts entries, and the /workspace mountpoint.
#
#   sudo -E bash tools/runner-real-journeys/stack/setup-host.sh
#
# Idempotent: regenerates nothing that already exists.

set -euo pipefail

COGBOX="${COGBOX_ROOT:-/home/user/work/cogbox}"
SSL="$COGBOX/tls"
mkdir -p "$SSL" /workspace

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

cp "$SSL/ca.crt" /usr/local/share/certificates/cogbox-ca.crt 2>/dev/null ||
  { mkdir -p /usr/local/share/ca-certificates && cp "$SSL/ca.crt" /usr/local/share/ca-certificates/cogbox-ca.crt; }
update-ca-certificates >/dev/null 2>&1 || true

for name in cogbox.local api.github.com; do
  if ! grep -q "127.0.0.1[[:space:]].*$name" /etc/hosts; then
    printf "127.0.0.1\t%s\n" "$name" >> /etc/hosts
    echo "[setup-host] added /etc/hosts entry for $name"
  fi
done

echo "[setup-host] done"
