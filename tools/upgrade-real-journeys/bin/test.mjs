#!/usr/bin/env node
/**
 * Suite test runner: runs the stage tests under Node 24 (the runtime the
 * orchestrator uses), bootstrapping the cached Node 24 install when missing.
 * Usage: node bin/test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CACHE_BIN = "/home/user/.cache/node24/bin/node";

async function resolveNode24() {
  if (process.version.startsWith("v24.")) return process.execPath;
  if (existsSync(CACHE_BIN)) return CACHE_BIN;
  const { ensureNode24 } = await import("../lib/node24.mjs");
  const node24 = await ensureNode24();
  const nodeDir = typeof node24 === "string" ? node24 : (node24?.nodeDir ?? null);
  if (nodeDir && existsSync(`${nodeDir}/node`)) return `${nodeDir}/node`;
  if (existsSync(CACHE_BIN)) return CACHE_BIN;
  throw new Error("Node 24 bootstrap did not produce a usable node binary");
}

const nodeBin = await resolveNode24();
const testsDir = fileURLToPath(new URL("../tests/", import.meta.url));
const result = spawnSync(nodeBin, ["--test", testsDir], { stdio: "inherit" });
process.exit(result.status ?? 1);
