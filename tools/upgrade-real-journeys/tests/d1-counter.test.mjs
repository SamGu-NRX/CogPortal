import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeShim } from "../lib/measure.mjs";

// A fake D1 binding that records how many statements the driver actually
// executed, so the proxy's reported count can be checked against reality.
class FakeStatement {
  constructor(sql, log) {
    this.sql = sql;
    this.log = log;
  }
  bind(...args) {
    const bound = new FakeStatement(this.sql, this.log);
    bound.args = args;
    return bound;
  }
  all() {
    this.log.push(`all:${this.sql}`);
    return { results: [] };
  }
  first() {
    this.log.push(`first:${this.sql}`);
    return null;
  }
  run() {
    this.log.push(`run:${this.sql}`);
    return { success: true };
  }
  raw() {
    this.log.push(`raw:${this.sql}`);
    return [];
  }
}
class FakeD1 {
  constructor() {
    this.executed = [];
  }
  prepare(sql) {
    return new FakeStatement(sql, this.executed);
  }
  batch(statements) {
    for (const statement of statements) this.executed.push(`batch:${statement.sql}`);
    return statements.map(() => ({ success: true }));
  }
  exec(sql) {
    for (const part of sql.split(";")) {
      if (part.trim().length > 0) this.executed.push(`exec:${part.trim()}`);
    }
    return "ok";
  }
}

function loadProxy() {
  // writeShim writes into the SUITE's .generated dir regardless of checkout.
  const checkout = mkdtempSync(join(tmpdir(), "upgrade-suite-counter-"));
  writeShim(checkout);
  const proxyUrl = new URL("../.generated/d1-proxy.ts", import.meta.url);
  return import(proxyUrl.href);
}

test("the D1 counter reports exactly the statements a request executes", async () => {
  const { countD1Proxy } = await loadProxy();

  const db = new FakeD1();
  const state = { statements: 0 };
  const counted = countD1Proxy(db, state);

  // A request that batches three prepared statements executes exactly three.
  counted.batch([counted.prepare("insert a"), counted.prepare("insert b"), counted.prepare("insert c")]);
  // A bound statement executed via all() executes exactly one.
  await counted.prepare("select one").bind(1).all();
  // A multi-statement exec() executes each ;-separated statement.
  counted.exec("create t; drop t;");
  // Single-row and mutation paths execute one each.
  await counted.prepare("select two").first();
  await counted.prepare("update t").run();

  assert.equal(state.statements, db.executed.length);
  assert.equal(state.statements, 8); // 3 batch + 1 all + 2 exec + 1 first + 1 run
});

test("preparing a statement without executing it counts nothing", async () => {
  const { countD1Proxy } = await loadProxy();

  const db = new FakeD1();
  const state = { statements: 0 };
  const counted = countD1Proxy(db, state);
  counted.prepare("select never run");
  assert.equal(state.statements, 0);
  assert.equal(db.executed.length, 0);
});
