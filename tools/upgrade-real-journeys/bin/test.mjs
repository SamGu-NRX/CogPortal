#!/usr/bin/env node
/**
 * Suite test runner: runs every tests/*.test.mjs file under Node 24 (the
 * runtime the orchestrator uses), bootstrapping the cached Node 24 install
 * when missing. Usage: node bin/test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
const testFiles = readdirSync(testsDir).filter((f) => f.endsWith(".test.mjs")).map((f) => join(testsDir, f));
if (testFiles.length === 0) {
  console.error("no test files found under", testsDir);
  process.exit(1);
}
const result = spawnSync(nodeBin, ["--test", ...testFiles], { stdio: "inherit" });
process.exit(result.status ?? 1);
