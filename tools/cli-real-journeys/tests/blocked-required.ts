import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The run bar's required-case contract, against the real report.mjs:
 * a required case that FAILs or is BLOCKED fails the run's verdict; a
 * receipt without the `required` field is required (fail-closed); only a
 * deliberate `required: false` witness is exempt, and its failure stays on
 * the summary as a tracked witness line. The receipts here are planted the
 * way the harness writes them; the subprocess is the real aggregator.
 */

let failures = 0;
function check(name: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`[ok] ${name} — ${detail}`);
  } else {
    console.error(`[FAIL] ${name} — ${detail}`);
    failures += 1;
  }
}

interface Row {
  journey: string;
  case: string;
  status: "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
  blockedReason?: string;
  required?: boolean;
}

async function runReport(receipts: Row[]): Promise<{ exit: number; summary: string }> {
  const dir = await mkdtemp(join(tmpdir(), "blocked-required-"));
  try {
    await mkdir(join(dir, "receipts"), { recursive: true });
    let index = 0;
    for (const receipt of receipts) {
      await writeFile(
        join(dir, "receipts", `${String(index).padStart(2, "0")}-${receipt.case}.json`),
        JSON.stringify({ ...receipt, claims: [], touched: [] }, null, 2),
      );
      index += 1;
    }
    const result = spawnSync(process.execPath, ["support/report.mjs"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, RESULTS_DIR: dir },
      encoding: "utf8",
    });
    const exit = result.status ?? 1;
    const summary = await readFile(join(dir, "summary.md"), "utf8").catch(() => "");
    return { exit, summary };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const pass: Row = { journey: "example", case: "passing-case", status: "PASS" };
const blockedRequired: Row = {
  journey: "example",
  case: "blocked-required-case",
  status: "BLOCKED",
  blockedReason: "conda environment week2 is missing on this machine",
  required: true,
};
const blockedLegacy: Row = {
  journey: "example",
  case: "blocked-legacy-case",
  status: "BLOCKED",
  blockedReason: "conda environment week2 is missing on this machine",
};
const blockedWitness: Row = {
  journey: "example",
  case: "blocked-optional-case",
  status: "BLOCKED",
  blockedReason: "conda environment week2 is missing on this machine",
  required: false,
};
const failedRequired: Row = {
  journey: "example",
  case: "failed-required-case",
  status: "FAIL",
  blockedReason: "the sync answer was wrong",
  required: true,
};
const failedWitness: Row = {
  journey: "device-name-witness",
  case: "start-proposes-device-name",
  status: "FAIL",
  blockedReason: "the start endpoint records the proposed device name — evidence: stored device_name: null",
  required: false,
};

{
  const { exit, summary } = await runReport([pass, blockedRequired]);
  check(
    "a BLOCKED required case fails the run verdict",
    exit === 1,
    `report exited ${exit}; expected 1`,
  );
  check(
    "the summary names the blocked required case and its reason",
    summary.includes("required case(s) are BLOCKED") && summary.includes("blocked-required-case") && summary.includes("conda environment week2 is missing"),
    summary.split("\n").find((line) => line.includes("BLOCKED")) ?? "no blocked line in the summary",
  );
}
{
  const { exit } = await runReport([pass, blockedLegacy]);
  check(
    "a BLOCKED receipt without the required field is still required (fail-closed)",
    exit === 1,
    `report exited ${exit}; expected 1`,
  );
}
{
  const { exit, summary } = await runReport([pass, blockedWitness]);
  check(
    "a BLOCKED non-required case does not fail the run verdict",
    exit === 0,
    `report exited ${exit}; expected 0`,
  );
  check(
    "a non-required BLOCKED case still appears as blocked in the counts",
    /0 failed, 1 blocked/.test(summary),
    "the summary's counts line",
  );
}
{
  const { exit } = await runReport([pass, failedRequired]);
  check("a FAIL required case fails the run verdict", exit === 1, `report exited ${exit}; expected 1`);
}
{
  const { exit, summary } = await runReport([pass, failedWitness]);
  check(
    "a FAILing non-required witness does not fail the run verdict",
    exit === 0,
    `report exited ${exit}; expected 0`,
  );
  check(
    "the summary carries the failing witness as a tracked line",
    summary.includes("non-required witness case(s) failing") && summary.includes("start-proposes-device-name"),
    summary.split("\n").find((line) => line.includes("start-proposes-device-name")) ?? "no witness line in the summary",
  );
}
{
  const { exit } = await runReport([pass]);
  check("a run whose cases all passed stays green", exit === 0, `report exited ${exit}; expected 0`);
}

if (failures > 0) {
  console.error(`blocked-required: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("blocked-required: all checks passed");
