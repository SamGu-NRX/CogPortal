import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { seedBenchmarkRow } from "../lib/state-gen.mjs";

const IDENTITY = {
  benchmark_id: "audio-identification",
  benchmark_version: 1,
  contract_version: "cogworks.submissions.v2",
  primary_metric: "identification_score",
};

function schema(db) {
  db.exec(`CREATE TABLE benchmarks (
    id TEXT NOT NULL, version INTEGER NOT NULL, contract_version TEXT NOT NULL,
    entry_point_name TEXT NOT NULL, title TEXT NOT NULL,
    module TEXT NOT NULL, summary TEXT NOT NULL,
    active INTEGER NOT NULL, primary_metric_key TEXT NOT NULL,
    PRIMARY KEY (id, version))`);
}

// The CLI's live run reports the plugin's own (benchmark_id, benchmark_version);
// beta's local-runs gate refuses the report unless that row is active.
test("seeds the plugin's identity as an active row", () => {
  const db = new DatabaseSync(":memory:");
  schema(db);
  seedBenchmarkRow(db, IDENTITY, "audio-identification", "week1");
  const row = db.prepare("SELECT * FROM benchmarks").get();
  assert.deepEqual(
    { id: row.id, version: row.version, active: row.active, module: row.module, primary_metric_key: row.primary_metric_key },
    { id: "audio-identification", version: 1, active: 1, module: "audio", primary_metric_key: "identification_score" },
  );
});

// The seed migration ships audio-recognition inactive under a different id, but
// a re-run must still repair a stale inactive row that shares the identity.
test("re-activates an existing row with the same identity", () => {
  const db = new DatabaseSync(":memory:");
  schema(db);
  db.prepare(
    "INSERT INTO benchmarks (id, version, contract_version, entry_point_name, title, module, summary, active, primary_metric_key) VALUES ('audio-identification', 1, 'x', 'x', 'x', 'audio', 'x', 0, 'x')",
  ).run();
  seedBenchmarkRow(db, IDENTITY, "audio-identification", "week1");
  assert.equal(db.prepare("SELECT active FROM benchmarks").get().active, 1);
});
