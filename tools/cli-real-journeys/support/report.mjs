// Aggregates the receipts a journey run wrote into one summary the operator
// reads: per-case status with the claims that carry the evidence, and the
// run's overall verdict. Exits nonzero when a required case FAILs or is
// BLOCKED, or nothing passed - run-all.sh surfaces that as its own exit code.
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

// Receipts are bound to the commit the run tested. With SUITE_HEAD set (as
// run-all.sh sets it), a receipt that names no head or another head fails
// the verdict: it is evidence about some other code.
const suiteHead = process.env.SUITE_HEAD ?? "";
const foreignHead = suiteHead ? rows.filter((r) => r.head?.sha !== suiteHead) : [];
const dirty = rows.some((r) => r.head?.dirty === true);

const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
const lines = ["# CLI real-journeys run", ""];
if (suiteHead) lines.push(`Commit under test: ${suiteHead}${dirty ? " (with uncommitted changes)" : ""}`, "");
lines.push("| journey | case | status |", "| --- | --- | --- |");
for (const row of rows) {
  counts[row.status] = (counts[row.status] ?? 0) + 1;
  lines.push(`| ${row.journey} | ${row.case} | ${row.status}${row.blockedReason ? ` — ${row.blockedReason}` : ""} |`);
}
lines.push("", `${counts.PASS} passed, ${counts.FAIL} failed, ${counts.BLOCKED} blocked, ${counts.NOT_RUN} not run.`, "");

// The run bar is required-case aware: a required case that FAILs or is
// BLOCKED fails the run's verdict. A receipt without the field is required
// (fail-closed), so only a deliberate `required: false` witness is exempt -
// its failure stays on the summary, but the tracked portal-side item it
// witnesses does not hold this CLI suite hostage.
const requiredFailed = rows.filter((r) => r.status === "FAIL" && r.required !== false);
const requiredBlocked = rows.filter((r) => r.status === "BLOCKED" && r.required !== false);
const witnessesFailing = rows.filter((r) => r.status === "FAIL" && r.required === false);

if (foreignHead.length > 0) {
  lines.push(`${foreignHead.length} receipt(s) are not bound to ${suiteHead} - they fail the run:`, "");
  for (const row of foreignHead) lines.push(`- ${row.journey} / ${row.case}: head ${row.head?.sha ?? "none"}`);
  lines.push("");
}
if (requiredBlocked.length > 0) {
  lines.push(`${requiredBlocked.length} required case(s) are BLOCKED - a blocked required case fails the run:`, "");
  for (const row of requiredBlocked) {
    lines.push(`- ${row.journey} / ${row.case}: ${row.blockedReason ?? "no reason recorded"}`);
  }
  lines.push("");
}
if (witnessesFailing.length > 0) {
  lines.push(`${witnessesFailing.length} non-required witness case(s) failing (tracked, not a run-bar failure):`, "");
  for (const row of witnessesFailing) {
    lines.push(`- ${row.journey} / ${row.case}: ${(row.blockedReason ?? "no reason recorded").slice(0, 300)}`);
  }
  lines.push("");
}

for (const row of rows.filter((r) => r.status !== "PASS")) {
  lines.push(`## ${row.journey} / ${row.case} (${row.status})`, "");
  if (row.blockedReason) lines.push(`Blocked: ${row.blockedReason}`, "");
  for (const claim of row.claims) lines.push(`- ${claim.claim} — ${claim.evidence}`);
  lines.push("");
}

const summary = lines.join("\n");
await (await import("node:fs/promises")).writeFile(join(resultsDir, "summary.md"), summary);
console.log(summary);

if (requiredFailed.length > 0 || requiredBlocked.length > 0 || foreignHead.length > 0 || counts.PASS === 0) process.exit(1);
