// BETA worktree manager. Beta (release parent of alpha, commit 17d26d9) is
// checked out into the suite's .cache/beta-worktree so a worker can drive
// beta's real SPA/API/CLI without touching the task checkout. Uses `git
// worktree` against the main clone - one clone per task, worktrees keep it to
// one checkout per ref.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const BETA_COMMIT = "17d26d9";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });
  if (r.status !== 0) {
    throw new Error(`beta-worktree: ${cmd} ${args.join(" ")} failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

/**
 * Ensure beta is checked out and its deps installed.
 * @param {{ repoDir: string, suiteDir: string, betaCommit?: string }} p
 * @returns {Promise<{ checkoutDir: string, reused: boolean }>}
 */
export async function ensureBetaWorktree({ repoDir, suiteDir, betaCommit = BETA_COMMIT }) {
  const checkoutDir = path.join(suiteDir, ".cache", "beta-worktree");
  const depsMarker = path.join(suiteDir, ".cache", "beta-worktree.deps-done");
  mkdirSync(path.dirname(checkoutDir), { recursive: true });

  if (!existsSync(path.join(checkoutDir, ".git"))) {
    run("git", ["-C", repoDir, "worktree", "add", "--detach", checkoutDir, betaCommit]);
  }
  const head = run("git", ["-C", checkoutDir, "rev-parse", "HEAD"]);
  if (!head.startsWith(betaCommit)) {
    throw new Error(`beta-worktree: expected ${betaCommit}, found ${head}`);
  }
  // No `git config user.*` here: a linked worktree shares the main clone's
  // repository config, so an identity written in the worktree silently
  // rewrites every later commit in that clone. Generating test state makes no
  // commits; anything that must commit (the CLI fixture repos) sets a
  // per-repository identity inside its own new .git instead.
  if (!existsSync(depsMarker)) {
    run("pnpm", ["install", "--prefer-offline"], { cwd: checkoutDir });
    writeFileSync(depsMarker, new Date().toISOString());
  }
  return { checkoutDir, reused: existsSync(depsMarker) };
}
