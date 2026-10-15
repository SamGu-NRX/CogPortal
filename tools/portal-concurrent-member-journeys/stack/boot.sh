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

# The dev toolchain may live outside a non-login shell's PATH (sandbox tmux).
export PATH="$HOME/.local/node22/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Fall back to corepack when pnpm isn't on PATH yet.
command -v pnpm >/dev/null 2>&1 || pnpm() { corepack pnpm "$@"; }

cd "$PORTAL"

if [ ! -f .dev.vars ]; then
  cp .dev.vars.example .dev.vars
  sed -i.bak "s|http://localhost:5173|http://localhost:$PORT|g" .dev.vars
  # Local-only auth secret; the Worker refuses to start with it empty.
  DEV_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  sed -i.bak "s|BETTER_AUTH_SECRET=\"\"|BETTER_AUTH_SECRET=\"$DEV_SECRET\"|" .dev.vars
fi

# A fresh database per boot: all migrations plus the local-only seed, exactly
# what pnpm dev's predev does. The seed restores the local join code (VISION26)
# and the fixture teams; the clock-skewed run is planted by the suite itself
# after the demo team exists.
rm -rf .wrangler/state/v3/d1
pnpm exec wrangler d1 migrations apply cogportal-db --local
pnpm exec wrangler d1 execute cogportal-db --local --file scripts/seed-local.sql

pnpm exec vite --port "$PORT" --strictPort
