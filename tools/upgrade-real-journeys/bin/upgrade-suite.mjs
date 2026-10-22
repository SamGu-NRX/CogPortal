#!/usr/bin/env node
// The one command: node bin/upgrade-suite.mjs [generate|journeys|clients|failures|volume]
// Runs stages against local D1 files only, writes receipts under receipts/.
// Stages never retry themselves; a flake is a failure (plan metric M1).
import { ensureNode24 } from "../lib/node24.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SUITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = process.argv[2] || "all";
const STAGES = ["generate", "journeys", "clients", "failures", "volume"];

if (!STAGES.includes(stage) && stage !== "all") {
  console.error(`unknown stage: ${stage} (use one of ${STAGES.join(", ")}, or omit for all)`);
  process.exit(2);
}

const { nodeDir, usedCache } = await ensureNode24();
console.log(`[upgrade-suite] node runtime: ${process.versions.node} (cached: ${usedCache})`);

const stages = stage === "all" ? STAGES : [stage];
const startedAll = Date.now();
const summary = [];
for (const s of stages) {
  const t0 = Date.now();
  console.log(`\n=== stage ${s} ===`);
  const r = spawnSync(nodeDir ? path.join(nodeDir, "node") : process.execPath, [path.join(SUITE, "suites", `${s}.mjs`)], {
    stdio: "inherit",
    env: { ...process.env, UPGRADE_SUITE_NODE_BIN: nodeDir || "" },
  });
  const ok = r.status === 0;
  summary.push({ stage: s, ok, ms: Date.now() - t0 });
  if (!ok) {
    console.error(`\n[upgrade-suite] stage ${s} FAILED (exit ${r.status}). Remaining stages not run.`);
    console.error(JSON.stringify({ stages: summary, totalMs: Date.now() - startedAll, failed: true }, null, 2));
    process.exit(r.status ?? 1);
  }
}
console.log(`\n[upgrade-suite] all requested stages passed in ${((Date.now() - startedAll) / 1000).toFixed(1)}s`);
for (const s of summary) console.log(`  ${s.ok ? "PASS" : "FAIL"} ${s.stage} (${(s.ms / 1000).toFixed(1)}s)`);
