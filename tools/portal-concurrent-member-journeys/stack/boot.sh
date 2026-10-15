#!/bin/sh
# Boots the real local stack for the concurrent-member journeys: a fresh local
# D1 (all migrations, repo seed, one clock-skewed run), then the portal dev
# server (production SPA path through Vite + the Worker) on port 5199.
# GitHub OAuth, Discord and Modal stay unconfigured; dev-auth sign-in and the
# fixture execution provider are the only providers, both local.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
PORTAL="$HERE/../../../apps/portal"
SUITE="$HERE/.."
PORT=5199

cd "$PORTAL"

if [ ! -f .dev.vars ]; then
  cp .dev.vars.example .dev.vars
  sed -i.bak "s|http://localhost:5173|http://localhost:$PORT|g" .dev.vars
  # Local-only auth secret; the Worker refuses to start with it empty.
  DEV_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  sed -i.bak "s|BETTER_AUTH_SECRET=\"\"|BETTER_AUTH_SECRET=\"$DEV_SECRET\"|" .dev.vars
fi

# A fresh database per boot, exactly what pnpm dev's predev does. The repo seed
# arrives with migration 0002; the clock-skewed run is planted by the suite
# itself after the demo team exists.
rm -rf .wrangler/state/v3/d1
pnpm exec wrangler d1 migrations apply cogportal-db --local

exec pnpm exec vite --port "$PORT" --strictPort
