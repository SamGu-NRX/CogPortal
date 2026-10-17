# Portal journey browser harness (evidence tooling)

The Playwright walk and axe drivers behind the evidence receipts in
`docs/design/evidence/connect-setup-journey.md` (commit a8aa493 evidence,
e8fc4d3 receipts). Serves the **built** portal behind a local fixture server —
no real GitHub or Modal calls.

## Files

- `fixture-server.mjs` — serves the built portal plus a scenario-controlled
  stub of the portal API (`POST /__fixture` to switch scenarios). No external
  calls.
- `walk.mjs` — six-path keyboard walk (first run create + approve, choice/join
  navigation, cohort join, refused device code, changed team, completed run).
  Writes `walk-report.json` and screenshots to `shots/`.
- `axe-scan.mjs` — axe-core scan of the connect choice screen, setup rail and
  connections device list. Writes `axe-report.json`.
- `probe-contrast.mjs`, `probe-overflow.mjs`, `probe-siblings.mjs`,
  `repro-410.mjs` — small debug drivers used while iterating the harness
  (gradient contrast sampling, layout overflow, sibling nav states, and the
  stacked-response-listener repro that explained a misleading triple-410
  report).
- `package.json` / `package-lock.json` — driver dependencies (playwright,
  axe-core). The portal build itself uses the repo workspace.

## Rerun

Node 22+ (the Cloudflare Vite plugin used by the portal build needs
`node:module`'s `registerHooks`, missing on Node 20).

```sh
# from the repo root, Node 22 on PATH
pnpm install
pnpm --filter @cogworks/portal build   # or the repo's standard portal build

# in this directory
npm ci
npx playwright install chromium
node fixture-server.mjs &               # serves http://localhost:4173
node walk.mjs                           # -> walk-report.json, shots/
node axe-scan.mjs                       # -> axe-report.json
```

The committed receipts (`docs/design/evidence/connect-setup-journey*.json`,
`*.png`) are the output of one such run at a8aa493.
