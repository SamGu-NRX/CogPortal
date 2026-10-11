// Local D1 lifecycle: find, migrate, snapshot, restore, inspect. Everything is
// a plain sqlite file inside a wrangler persist dir - the same dir the
// @cloudflare/vite-plugin uses for `vite preview` (<checkout>/apps/portal/.wrangler/state),
// so migrations applied here are exactly what the built Worker reads.
import { existsSync, readdirSync, statSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DATABASE_ID = "cogportal-db";

/** Newest *.sqlite file under a wrangler persist dir (walks mnt/, v3/, d1/...). */
export function findD1File(persistDir) {
  if (!existsSync(persistDir)) throw new Error(`findD1File: ${persistDir} does not exist`);
  const hits = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".sqlite")) hits.push({ file: p, mtime: statSync(p).mtimeMs });
    }
  })(persistDir);
  if (hits.length === 0) throw new Error(`findD1File: no *.sqlite under ${persistDir}`);
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0].file;
}

export function persistDirFor(checkoutDir) {
  return path.join(checkoutDir, "apps", "portal", ".wrangler", "state");
}

/** Run alpha's (or beta's) migrations against a fresh persist dir, in deployment order. */
export function applyMigrations({ checkoutDir, databaseId = DATABASE_ID, nodeDir }) {
  const persistDir = persistDirFor(checkoutDir);
  mkdirSync(persistDir, { recursive: true });
  const env = { ...process.env };
  if (nodeDir) env.PATH = `${nodeDir}:${env.PATH}`;
  const r = spawnSync(
    "pnpm",
    ["exec", "wrangler", "d1", "migrations", "apply", databaseId, "--local", `--persist-to=${persistDir}`],
    { cwd: checkoutDir, encoding: "utf8", env, timeout: 300_000 },
  );
  if (r.status !== 0) {
    throw new Error(`d1 migrations failed (exit ${r.status}):\n${(r.stderr || "") + (r.stdout || "")}`);
  }
  return { persistDir, output: r.stdout };
}

/** Copy the whole persist dir (small) with a metadata receipt. */
export function snapshot(persistDir, destDir) {
  if (!existsSync(persistDir)) throw new Error(`snapshot: source ${persistDir} missing`);
  rmSync(destDir, { recursive: true, force: true });
  cpSync(persistDir, destDir, { recursive: true });
  writeFileSync(path.join(destDir, "snapshot-meta.json"), JSON.stringify({
    snapshotAt: new Date().toISOString(),
    source: persistDir,
    files: readdirSync(persistDir, { recursive: true }).filter((f) => f.endsWith(".sqlite")),
  }, null, 2));
  return destDir;
}

/** Restore a snapshot into a target persist dir (replaces it wholesale). */
export function restoreSnapshot(snapshotDir, persistDir) {
  if (!existsSync(snapshotDir)) throw new Error(`restoreSnapshot: ${snapshotDir} missing`);
  rmSync(persistDir, { recursive: true, force: true });
  mkdirSync(path.dirname(persistDir), { recursive: true });
  cpSync(snapshotDir, persistDir, { recursive: true });
  rmSync(path.join(persistDir, "snapshot-meta.json"), { force: true });
  return persistDir;
}

/** Direct read access to the sqlite file (Node >= 24 only). */
export function openD1(dbFile) {
  return new DatabaseSync(dbFile);
}

export function tables(dbFile) {
  return openD1(dbFile).prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
}

export function listAppliedMigrations(dbFile) {
  const has = openD1(dbFile).prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'").get();
  if (!has) return [];
  return openD1(dbFile).prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((r) => r.name);
}
