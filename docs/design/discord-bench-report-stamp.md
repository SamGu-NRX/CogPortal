# Discord bench-report stamp — spec and gate

**Status:** taste preview approved for consideration; NOT wired to production
**Preview:** `pnpm --filter @cogworks/discord-kit exec node scripts/render-bench-stamp.mjs`
(writes `packages/discord-kit/emoji/dist/stamp-*.png`)

## What it is

A small image card attached to the public run message at terminal states only,
as a Section **thumbnail** accessory (renders ~240px, right side). It is the
one place real typography (Source Serif 4, IBM Plex Mono, the paper ground,
the detection brackets) can enter a Discord channel.

Composition, top to bottom, inside detect-red corner brackets on paper:

1. mono eyebrow, letterspaced: `BENCH CLEAR` (verify green) / `PUBLISHED`
   (detect red) / nothing for failures — failures never get a stamp
2. the score, Source Serif 4 semibold, the largest thing by far
3. mono metric label: `accuracy, higher is better`
4. thin rule
5. benchmark title, serif italic
6. mono provenance: `sha  duration  simulated?`

Trust rules: only terminal, observed results; `simulated` is always printed
when true; local self-reported runs get the stamp only with a
`self-reported` provenance word.

## Why it is not in production yet

- The portal runs on the Workers **free plan** (~10ms CPU); satori/resvg
  rasterization needs tens-to-hundreds of ms. Not viable on-worker today.
- Each message edit after attachment must resend the full `attachments`
  array (v10 semantics), including in the 404-recreate path of
  `syncRunSurfaceMessage`, plus a D1 column to remember the attachment.
  That delivery work only makes sense once rendering is possible.

## Upgrade paths (pick one when wanted)

1. **Paid Workers plan** (`limits.cpu_ms`), render with satori +
   `@resvg/resvg-wasm` (workers-og pattern), WASM initialized at module scope,
   fonts shipped as subset TTFs.
2. **External render service** (a tiny Modal function or any host that can
   run resvg) returning a PNG the worker attaches; the runner infrastructure
   already exists.
3. Pre-render only for **published** results via a queue consumer, since
   publication is rare and not latency-sensitive.

Terminal states never change after the stamp lands (publication swaps the
whole composition anyway), so live-update pressure on the image is nil.
