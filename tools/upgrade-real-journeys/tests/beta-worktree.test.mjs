import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureBetaWorktree } from "../lib/beta-worktree.mjs";

function gitOut(cwd, args) {
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// A stand-in for the suite's clone: one repo, one commit, its own identity.
function mainRepoWithCommit() {
  const repoDir = mkdtempSync(join(tmpdir(), "upgrade-suite-bw-repo-"));
  gitOut(repoDir, ["init"]);
  gitOut(repoDir, ["config", "user.name", "Main Repo Identity"]);
  gitOut(repoDir, ["config", "user.email", "main@repo.local"]);
  writeFileSync(join(repoDir, "README.md"), "beta\n");
  gitOut(repoDir, ["add", "-A"]);
  gitOut(repoDir, ["commit", "-m", "beta snapshot"]);
  return repoDir;
}

test("ensureBetaWorktree never writes a git identity into the shared clone config", async () => {
  const repoDir = mainRepoWithCommit();
  const suiteDir = mkdtempSync(join(tmpdir(), "upgrade-suite-bw-suite-"));
  // A deps marker skips the pnpm install the helper would otherwise run.
  mkdirSync(join(suiteDir, ".cache"), { recursive: true });
  writeFileSync(join(suiteDir, ".cache", "beta-worktree.deps-done"), "test");
  const commit = gitOut(repoDir, ["rev-parse", "HEAD"]);
  const { checkoutDir } = await ensureBetaWorktree({ repoDir, suiteDir, betaCommit: commit });
  assert.equal(gitOut(checkoutDir, ["rev-parse", "HEAD"]), commit);
  // The regression: a linked worktree shares the main clone's repository
  // config, so an identity written through the worktree silently rewrote
  // every later commit in that clone.
  assert.equal(gitOut(repoDir, ["config", "user.name"]), "Main Repo Identity");
  assert.equal(gitOut(repoDir, ["config", "user.email"]), "main@repo.local");
});

test("ensureBetaWorktree reuses an existing worktree at the pinned commit", async () => {
  const repoDir = mainRepoWithCommit();
  const suiteDir = mkdtempSync(join(tmpdir(), "upgrade-suite-bw-suite2-"));
  mkdirSync(join(suiteDir, ".cache"), { recursive: true });
  writeFileSync(join(suiteDir, ".cache", "beta-worktree.deps-done"), "test");
  const commit = gitOut(repoDir, ["rev-parse", "HEAD"]);
  const first = await ensureBetaWorktree({ repoDir, suiteDir, betaCommit: commit });
  const second = await ensureBetaWorktree({ repoDir, suiteDir, betaCommit: commit });
  assert.equal(first.checkoutDir, second.checkoutDir);
  assert.equal(gitOut(second.checkoutDir, ["rev-parse", "HEAD"]), commit);
});
