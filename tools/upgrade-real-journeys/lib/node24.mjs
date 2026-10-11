// Node 24 bootstrap. Portal tests and workerd-based local D1 need Node >= 24
// (node:sqlite); the sandbox base image ships Node 20. Idempotent, cached under
// /home/user/.cache/node24. Returns nodeDir (null = current runtime is fine).
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const CACHE = "/home/user/.cache/node24";
const VERSION = "v24.10.0";

export async function ensureNode24() {
  if (process.versions.node.startsWith("24.")) {
    return { nodeDir: null, usedCache: false };
  }
  const bin = path.join(CACHE, "bin", "node");
  if (existsSync(bin)) return { nodeDir: CACHE, usedCache: true };

  const url = `https://nodejs.org/dist/${VERSION}/node-${VERSION}-linux-x64.tar.xz`;
  const tmp = `/tmp/node-${VERSION}.tar.xz`;
  mkdirSync(CACHE, { recursive: true });
  const dl = spawnSync("curl", ["-fsSL", "-o", tmp, "--max-time", "180", url], { stdio: "inherit" });
  if (dl.status !== 0) {
    rmSync(CACHE, { recursive: true, force: true });
    throw new Error(`node24 bootstrap: download failed (${url}, exit ${dl.status})`);
  }
  const ex = spawnSync("tar", ["-xJf", tmp, "-C", CACHE, "--strip-components=1"], { stdio: "inherit" });
  if (ex.status !== 0) {
    rmSync(CACHE, { recursive: true, force: true });
    throw new Error(`node24 bootstrap: extract failed (exit ${ex.status})`);
  }
  if (!existsSync(bin)) {
    // some tar layouts keep the version dir; normalize
    const nested = path.join(CACHE, `node-${VERSION}-linux-x64`);
    if (existsSync(path.join(nested, "bin", "node"))) {
      renameSync(nested, CACHE + ".real");
      rmSync(CACHE, { recursive: true, force: true });
      renameSync(CACHE + ".real", CACHE);
    } else {
      throw new Error("node24 bootstrap: node binary not found after extract");
    }
  }
  return { nodeDir: CACHE, usedCache: false };
}
