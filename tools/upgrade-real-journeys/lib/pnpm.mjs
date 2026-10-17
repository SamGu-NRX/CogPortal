// pnpm bootstrap for environments that ship Node without pnpm. The suite's
// other helpers (beta worktree deps, wrangler migrations, portal build, vite
// preview) all shell out to `pnpm`, and the repo pins pnpm@10.34.5 in
// packageManager - so the suite carries its own activation: corepack shims
// dropped into a private dir, falling back to an npm install into the same
// private prefix. Never writes outside the suite's .cache.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const PNPM_VERSION = "10.34.5";

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    throw new Error(
      `pnpm.mjs: ${cmd} ${args.join(" ")} failed (exit ${r.status}):\n${(r.stderr || "") + (r.stdout || "")}`.slice(-2000),
    );
  }
  return (r.stdout || "").trim();
}

/**
 * Ensure pnpm is usable by later spawnSync calls (they inherit process.env).
 * @param {{ nodeDir?: string, cacheDir: string }} p
 * @returns {Promise<{ pnpmBin: string, version: string }>}
 */
export async function ensurePnpm({ nodeDir, cacheDir }) {
  const env = { ...process.env };
  const parts = [nodeDir, nodeDir && `${nodeDir}/bin`].filter(Boolean);
  if (env.PATH) parts.push(env.PATH);
  env.PATH = parts.join(":");

  const probe = (bin) => {
    try {
      return run(bin, ["--version"], env);
    } catch {
      return null;
    }
  };

  // Already usable somewhere on PATH (or next to the Node 24 runtime)?
  for (const candidate of ["pnpm", nodeDir && path.join(nodeDir, "pnpm")].filter(Boolean)) {
    const found = probe(candidate);
    if (found) {
      process.env.PATH = env.PATH;
      return { pnpmBin: candidate, version: found };
    }
  }

  mkdirSync(cacheDir, { recursive: true });
  const shimDir = path.join(cacheDir, "bin");
  mkdirSync(shimDir, { recursive: true });
  env.PATH = `${shimDir}:${env.PATH}`;
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";

  // Preferred: corepack (ships with Node), shims in a private dir.
  try {
    run("corepack", ["enable", "--install-directory", shimDir], env);
    run("corepack", ["prepare", `pnpm@${PNPM_VERSION}`, "--activate"], env);
    const shim = path.join(shimDir, "pnpm");
    const version = probe(shim);
    if (version) {
      process.env.PATH = env.PATH;
      return { pnpmBin: shim, version };
    }
  } catch (corepackError) {
    // Named, then deliberately falling through to the npm fallback below.
    console.error(`[pnpm.mjs] corepack activation failed: ${String(corepackError).slice(0, 300)}`);
  }

  // Fallback: npm global install into a private prefix under .cache.
  const prefix = path.join(cacheDir, "npm-prefix");
  run("npm", ["install", "--global", `pnpm@${PNPM_VERSION}`, `--prefix=${prefix}`], env);
  const pnpmBin = path.join(prefix, "bin", "pnpm");
  if (!existsSync(pnpmBin)) {
    throw new Error("pnpm.mjs: npm prefix install did not produce a pnpm binary");
  }
  env.PATH = `${path.join(prefix, "bin")}:${env.PATH}`;
  process.env.PATH = env.PATH;
  const version = probe(pnpmBin);
  return { pnpmBin, version };
}
