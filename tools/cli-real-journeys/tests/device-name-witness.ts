import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The device-name witness's own contract, over real loopback HTTP for the
 * start call and scripted outcomes for the D1 read.
 *
 * Before this fix (c722ed79, journeys/device-name-witness.ts:67-81) a failed
 * wrangler command, unparseable output and a missing row all became
 * `stored: null`, which read as the known name drop, and run-all.sh counted
 * every witness failure as that defect. Now:
 *   - a portal that drops the name: the row read passes, the non-required
 *     name case fails naming `stored device_name: null`, exit code 3;
 *   - a portal that records it: both pass, exit code 0;
 *   - a failed read, malformed output, a missing row or two rows: the
 *     required read case fails, the name case is BLOCKED (never the known
 *     drop), exit code 1.
 * The pre-fix parser is replayed inline to show it mapped each bad read to
 * the same null the real drop produces.
 */
const scratch = await mkdtemp(join(tmpdir(), "device-name-witness-"));
process.env.RESULTS_DIR = scratch;
const { runWitness, portalDeps } = await import("../journeys/device-name-witness.ts");

let failures = 0;
function check(name: string, condition: boolean, detail: string): void {
  console.log(`[${condition ? "ok" : "FAIL"}] ${name} — ${detail}`);
  if (!condition) failures += 1;
}

/** The pre-fix parser: anything unreadable became null. */
function preFixStored(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as Array<{ results?: Array<{ device_name: string | null }> }>;
    return parsed[0]?.results?.[0]?.device_name ?? null;
  } catch {
    return null;
  }
}

/** A portal start double: mints a user code and remembers the proposed name. */
async function startDouble(): Promise<{ origin: string; proposals: Map<string, string>; close(): Promise<void> }> {
  const proposals = new Map<string, string>();
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk;
    });
    request.on("end", () => {
      const userCode = `TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      proposals.set(userCode, (JSON.parse(raw) as { deviceName: string }).deviceName);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ deviceCode: "d".repeat(64), userCode, verificationUri: "http://127.0.0.1/connections", expiresAt: Date.now() + 600_000, pollIntervalSeconds: 5 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    proposals,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const wranglerRows = (rows: unknown[]): string => JSON.stringify([{ results: rows, success: true, meta: {} }]);

async function receipt(name: string): Promise<{ status: string; claims: Array<{ claim: string; evidence: string }>; blockedReason?: string; required: boolean }> {
  return JSON.parse(await readFile(join(scratch, "receipts", `device-name-witness--${name}.json`), "utf8"));
}

const double = await startDouble();
try {
  type Read = (userCode: string) => { exit: number; output: string };
  const scenario = async (read: Read) => {
    const outcome = await runWitness(double.origin, { sendStart: portalDeps.sendStart, readAuthorization: async (code) => read(code) });
    process.exitCode = 0; // the harness sets it on expected failures; this test judges below
    return { outcome, readReceipt: await receipt("start-row-readable"), nameReceipt: await receipt("start-proposes-device-name") };
  };

  {
    const { outcome, nameReceipt } = await scenario(() => ({ exit: 0, output: wranglerRows([{ device_name: null }]) }));
    check(
      "a portal that drops the name: read passes, the name case fails on the null, exit 3",
      outcome.read === "PASS" && outcome.name === "FAIL" && outcome.exitCode === 3 &&
        JSON.stringify(nameReceipt.claims).includes("stored device_name: null") && nameReceipt.required === false,
      JSON.stringify(outcome),
    );
  }
  {
    const { outcome } = await scenario((code) => ({ exit: 0, output: wranglerRows([{ device_name: double.proposals.get(code) }]) }));
    check("a portal that records the name: both pass, exit 0", outcome.read === "PASS" && outcome.name === "PASS" && outcome.exitCode === 0, JSON.stringify(outcome));
  }

  const badReads: Array<[string, { exit: number; output: string }]> = [
    ["the wrangler command failed", { exit: 1, output: "✘ [ERROR] D1_ERROR: no such table: device_authorizations" }],
    ["the output is not JSON", { exit: 0, output: "Executing on local database cogportal-db…" }],
    ["the user code has no row", { exit: 0, output: wranglerRows([]) }],
    ["two rows came back", { exit: 0, output: wranglerRows([{ device_name: null }, { device_name: null }]) }],
  ];
  for (const [label, result] of badReads) {
    check(`red: the pre-fix parser turned "${label}" into the known drop's null`, result.exit !== 0 || preFixStored(result.output) === null, "");
    const { outcome, readReceipt, nameReceipt } = await scenario(() => result);
    check(
      `green: ${label}: the required read fails, the name case is BLOCKED, exit 1`,
      outcome.read === "FAIL" && readReceipt.required === true && outcome.name === "BLOCKED" &&
        !JSON.stringify(nameReceipt.claims).includes("stored device_name: null") && outcome.exitCode === 1,
      `${JSON.stringify(outcome)}; read: ${JSON.stringify(readReceipt.claims.at(-1)?.evidence ?? "").slice(0, 160)}`,
    );
  }
} finally {
  await double.close();
  await rm(scratch, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`device-name-witness: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("device-name-witness: all checks passed");
