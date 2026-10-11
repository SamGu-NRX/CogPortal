// Aggregates the receipts a journey run wrote into one summary the operator
// reads: per-case status with the claims that carry the evidence, and the
// run's overall verdict. Exits nonzero when any case failed — run-all.sh
// surfaces that as its own exit code.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const resultsDir = process.env.RESULTS_DIR;
if (!resultsDir) {
  console.error("RESULTS_DIR is not set");
  process.exit(2);
}

const receiptsDir = join(resultsDir, "receipts");
const files = (await readdir(receiptsDir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
if (files.length === 0) {
  console.error(`no receipts under ${receiptsDir}; did the journeys run?`);
  process.exit(2);
}

const rows = [];
for (const name of files) {
  const receipt = JSON.parse(await readFile(join(receiptsDir, name), "utf8"));
  rows.push(receipt);
}

const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
const lines = ["# CLI real-journeys run", "", "| journey | case | status |", "| --- | --- | --- |"];
for (const row of rows) {
  counts[row.status] = (counts[row.status] ?? 0) + 1;
  lines.push(`| ${row.journey} | ${row.case} | ${row.status}${row.blockedReason ? ` — ${row.blockedReason}` : ""} |`);
}
lines.push("", `${counts.PASS} passed, ${counts.FAIL} failed, ${counts.BLOCKED} blocked, ${counts.NOT_RUN} not run.`, "");

for (const row of rows.filter((r) => r.status !== "PASS")) {
  lines.push(`## ${row.journey} / ${row.case} (${row.status})`, "");
  if (row.blockedReason) lines.push(`Blocked: ${row.blockedReason}`, "");
  for (const claim of row.claims) lines.push(`- ${claim.claim} — ${claim.evidence}`);
  lines.push("");
}

const summary = lines.join("\n");
await (await import("node:fs/promises")).writeFile(join(resultsDir, "summary.md"), summary);
console.log(summary);

if (counts.FAIL > 0 || counts.PASS === 0) process.exit(1);
