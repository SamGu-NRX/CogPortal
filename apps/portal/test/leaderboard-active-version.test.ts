import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { benchmarks } from "../worker/db/schema.ts";
import type { Env } from "../worker/env.ts";
import { getLeaderboardReadModel } from "../worker/services/leaderboard.ts";

/**
 * A leaderboard link carries the benchmark id, and the read model resolves
 * that id to one benchmarks row. Opening the board on the highest version
 * even when that version had been deactivated made the link resolve to a
 * measure that is no longer in force: the page picks the active row and
 * sends only the id. The read model must prefer the active version, and
 * fall back to the newest row only when no version is active — which is
 * what an archive board shows.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function freshBinding(): unknown {
  const sqlite = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => !/^(0002_seed|0016_backfill)/.test(file));
  for (const file of files) sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));

  function prepare(query: string) {
    const statement = sqlite.prepare(query);
    let bound: never[] = [];
    const prepared = {
      bind(...params: unknown[]) {
        bound = params as never[];
        return prepared;
      },
      async run() {
        return { success: true, meta: statement.run(...bound) };
      },
      async all() {
        return { success: true, results: statement.all(...bound) };
      },
      async raw() {
        statement.setReturnArrays(true);
        const rows = statement.all(...bound);
        statement.setReturnArrays(false);
        return rows;
      },
    };
    return prepared;
  }
  return { prepare };
}

/**
 * audio-identification v1 arrives from migration 0020 with active = 0. The
 * scenarios flip activity rather than invent ids, so the rows are exactly
 * the ones a deployment runs with.
 */
async function seeded(activeV1: boolean, activeV2: boolean): Promise<Env> {
  const binding = freshBinding();
  const db = drizzle(binding as never);
  await db
    .update(benchmarks)
    .set({ active: activeV1 })
    .where(and(eq(benchmarks.id, "audio-identification"), eq(benchmarks.version, 1)));
  await db.insert(benchmarks).values({
    id: "audio-identification",
    version: 2,
    contractVersion: "cogworks.submissions.v2",
    entryPointName: "audio-identification",
    title: "Song Identification",
    module: "audio",
    summary: "A version withdrawn mid-course.",
    active: activeV2,
    primaryMetricKey: "identification_score",
    pluginVersion: "0.1.0",
    datasetVersion: "synth-v1",
    scorerVersion: "identification-v1",
    runtimeVersion: "week1-cpu-v1",
  });
  return { DB: binding } as unknown as Env;
}

test("a deactivated newest version does not displace the active one", async () => {
  const board = await getLeaderboardReadModel(await seeded(true, false), "audio-identification");
  assert.equal(board.benchmark.version, 1, "the active version is what a link resolves to");
});

test("with no active version left, the newest row is what an archive board opens on", async () => {
  const board = await getLeaderboardReadModel(await seeded(false, false), "audio-identification");
  assert.equal(board.benchmark.version, 2);
});
