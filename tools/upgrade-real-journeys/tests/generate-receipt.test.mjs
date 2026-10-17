import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runWithFailureReceipt } from "../lib/failure-receipt.mjs";

function tempReceipt(name) {
  const dir = mkdtempSync(join(tmpdir(), `upgrade-suite-${name}-`));
  return pathToFileURL(join(dir, "receipts", "generate.json"));
}

test("failed generation rethrows the awaited error and still writes a receipt", async () => {
  const receipt = tempReceipt("failure");
  const boom = new Error("simulated generation failure");
  await assert.rejects(
    () =>
      runWithFailureReceipt(receipt, async () => {
        throw boom;
      }),
    (error) => error === boom,
  );
  const receiptBody = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(receiptBody.status, "failed");
  assert.equal(receiptBody.stage, "generate");
  assert.match(receiptBody.error, /simulated generation failure/);
});

test("failed receipt writes never mask the original error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upgrade-suite-blocked-"));
  const receipt = pathToFileURL(join(dir, "receipts", "generate.json"));
  writeFileSync(join(dir, "receipts"), "not a directory");
  const boom = new Error("original failure");
  await assert.rejects(
    () =>
      runWithFailureReceipt(receipt, async () => {
        throw boom;
      }),
    (error) => error === boom,
  );
});

test("successful generation returns the work result and writes no failure receipt", async () => {
  const receipt = tempReceipt("success");
  const result = await runWithFailureReceipt(receipt, async () => 42);
  assert.equal(result, 42);
  assert.equal(existsSync(receipt), false);
});

test("the generator awaits every async phase before its receipt is written", async () => {
  // Pins the defect: cliPhase ran unawaited, so generation could throw before
  // the receipt write while the CLI phase raced server teardown.
  const source = readFileSync(new URL("../lib/state-gen.mjs", import.meta.url), "utf8");
  assert.match(source, /await cliPhase\(/);
});
