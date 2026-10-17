import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findD1File } from "../lib/d1.mjs";

// Builds a realistic wrangler persist tree. Miniflare keeps each D1 database
// at v3/d1/<unique-key>/db.sqlite, its own bookkeeping at
// v3/d1/metadata.sqlite, and Durable Object storage under v3/do/. The files
// are touched so an mtime-ordered walk over every *.sqlite would land on the
// metadata file - exactly the wrong pick the old discovery made.
function decoyPersistDir() {
  const root = mkdtempSync(join(tmpdir(), "upgrade-suite-d1-"));
  mkdirSync(join(root, "mnt"), { recursive: true });
  mkdirSync(join(root, "v3", "d1", "aaaa1111"), { recursive: true });
  mkdirSync(join(root, "v3", "d1", "bbbb2222"), { recursive: true });
  mkdirSync(join(root, "v3", "do", "live-ns"), { recursive: true });
  writeFileSync(join(root, "mnt", "older.sqlite"), "");
  writeFileSync(join(root, "v3", "d1", "metadata.sqlite"), "");
  writeFileSync(join(root, "v3", "d1", "aaaa1111", "db.sqlite"), "");
  writeFileSync(join(root, "v3", "do", "live-ns", "object.sqlite"), "");
  writeFileSync(join(root, "v3", "d1", "bbbb2222", "db.sqlite"), "");
  const at = (ms) => new Date(ms);
  const now = Date.now();
  utimesSync(join(root, "mnt", "older.sqlite"), at(0), at(0));
  utimesSync(join(root, "v3", "d1", "metadata.sqlite"), at(now), at(now));
  utimesSync(join(root, "v3", "d1", "aaaa1111", "db.sqlite"), at(now - 60_000), at(now - 60_000));
  utimesSync(join(root, "v3", "do", "live-ns", "object.sqlite"), at(now - 30_000), at(now - 30_000));
  utimesSync(join(root, "v3", "d1", "bbbb2222", "db.sqlite"), at(now - 5_000), at(now - 5_000));
  return root;
}

test("findD1File picks a real D1 database file, never metadata or DO storage", () => {
  const root = decoyPersistDir();
  const found = findD1File(root);
  assert.equal(found, join(root, "v3", "d1", "bbbb2222", "db.sqlite"));
});

test("findD1File refuses a persist dir without D1 storage", () => {
  const root = mkdtempSync(join(tmpdir(), "upgrade-suite-d1-empty-"));
  assert.throws(() => findD1File(root), /no D1 storage/);
});

test("findD1File refuses a D1 tree holding only the metadata file", () => {
  const root = mkdtempSync(join(tmpdir(), "upgrade-suite-d1-meta-"));
  mkdirSync(join(root, "v3", "d1"), { recursive: true });
  writeFileSync(join(root, "v3", "d1", "metadata.sqlite"), "");
  assert.throws(() => findD1File(root), /no D1 database file/);
});
