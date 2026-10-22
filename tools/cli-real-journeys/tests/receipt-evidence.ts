/**
 * The receipt-evidence contract (review block: "phantom receipts"),
 * demonstrated through the real harness writing real receipts.
 *
 * A PASS receipt must not exist without bound evidence of a real executed
 * command or a recorded claim. The reviewed code stamped PASS receipts from
 * cases that ran nothing — eight per full matrix run, wherever
 * PIN_TEST_BENCHMARK was empty — so the harness now records BLOCKED for a
 * case that ran no command and asserted nothing, and pin-exercise writes no
 * small-case receipt at all where the week's real-data journey already
 * scores one under the same pinned CLI.
 *
 * Demonstrated here against receipts this test actually writes:
 *   - a case that runs a real command and asserts on its real output is
 *     PASS, and its claims contain the command's actual output;
 *   - the old phantom shape (a body that runs nothing) is BLOCKED now, not
 *     PASS — the receipt count for "PASS with no command and no claims"
 *     goes to zero (it was one per such case before, eight per matrix run);
 *   - a claims-only case (no commands) stays PASS — the bar targets
 *     evidence-free receipts, not command-free ones.
 *
 * Run: npx tsx tests/receipt-evidence.ts  (no network, no stack)
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

let failures = 0;
function check(label: string, ok: boolean, evidence: string): void {
  console.log(`[${ok ? "ok" : "FAIL"}] ${label} — ${evidence}`);
  if (!ok) failures += 1;
}

const resultsDir = await mkdtemp(join(tmpdir(), "receipt-evidence-"));
process.env.RESULTS_DIR = resultsDir;
const { Case } = await import("../journeys/harness.ts");

try {
  // 1. A real command behind a PASS receipt.
  const real = new Case("receipt-evidence", "real-command-case", []);
  await real.run(async () => {
    const result = await run("node", ["-e", "console.log('cogbench scored: 0.87')"]);
    real.command(`node -e "console.log('cogbench scored: 0.87')"`, 0, result.stdout);
    real.expect(
      result.stdout.includes("0.87"),
      "the command's real output carries the claim",
      result.stdout.trim(),
    );
  });

  // 2. The old phantom shape: a case body that runs nothing.
  const noop = new Case("receipt-evidence", "no-op-case", []);
  await noop.run(async () => {});

  // 3. A claims-only case stays PASS.
  const claimsOnly = new Case("receipt-evidence", "claims-only-case", []);
  await claimsOnly.run(async () => {
    claimsOnly.claim("an observation made without a command", "the evidence text behind it");
  });

  const files = (await readdir(join(resultsDir, "receipts"))).filter((name) => name.endsWith(".json")).sort();
  check("three cases wrote three receipts", files.length === 3, `receipt files: ${files.join(", ")}`);

  const statuses = new Map<string, any>();
  for (const name of files) {
    const receipt = JSON.parse(await readFile(join(resultsDir, "receipts", name), "utf8"));
    statuses.set(receipt.case, receipt);
  }

  const realReceipt = statuses.get("real-command-case");
  check(
    "the real command's case is PASS",
    realReceipt?.status === "PASS",
    `status ${realReceipt?.status}, commands recorded: ${realReceipt?.commands?.length ?? 0}`,
  );
  const boundEvidence = (realReceipt?.claims ?? []).map((c: any) => `${c.claim} — ${c.evidence}`).join(" | ");
  check(
    "the receipt's claims contain the actual command output",
    boundEvidence.includes("cogbench scored: 0.87"),
    boundEvidence.slice(0, 200),
  );

  const noopReceipt = statuses.get("no-op-case");
  check(
    "the old phantom shape is BLOCKED, not PASS (before: PASS with empty claims and commands)",
    noopReceipt?.status === "BLOCKED",
    `status ${noopReceipt?.status}; reason: ${noopReceipt?.blockedReason ?? "-"}`,
  );

  const claimsReceipt = statuses.get("claims-only-case");
  check(
    "a claims-only case still counts as PASS",
    claimsReceipt?.status === "PASS" && (claimsReceipt?.claims?.length ?? 0) > 0,
    `status ${claimsReceipt?.status}, claims: ${claimsReceipt?.claims?.length ?? 0}`,
  );

  const phantomPasses = [...statuses.values()]
    .filter((r: any) => r.status === "PASS" && (r.commands?.length ?? 0) === 0 && (r.claims?.length ?? 0) === 0).length;
  check(
    "no PASS receipt exists without bound evidence of a real command or a claim",
    phantomPasses === 0,
    `PASS receipts with no commands and no claims: ${phantomPasses} (was 1 per no-op case, 8 per matrix run)`,
  );
} finally {
  await rm(resultsDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`receipt-evidence: ${failures} check(s) failed`);
  process.exit(1);
}
// The harness sets process.exitCode = 1 for the deliberately BLOCKED no-op
// case inside this process; the test's own verdict is explicit instead.
console.log("receipt-evidence: all checks passed");
process.exit(0);
