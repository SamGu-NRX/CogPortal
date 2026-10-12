/**
 * The online egress rule: during a command that is allowed to download, any
 * attempt to reach a host that is neither loopback nor a documented
 * public-asset host fails the case, refused or not.
 *
 * Before this fix (c722ed79, journeys/real-data-common.ts:161-162) the online
 * check judged only attempts the proxy ALLOWED, so a refused Discord or
 * deployed-portal attempt was logged and the case still passed.
 *
 * This test boots the real proxy (support/egress.mjs), sends real requests
 * through it with curl to hosts it refuses before opening any upstream socket
 * (nothing leaves the machine), then judges the recorded window both ways:
 *   - the pre-fix rule passes the window (the defect);
 *   - assertOnlineEgress, which the week 2/3 online cases call, fails a real
 *     journey Case on it and names each refused host;
 *   - a window of documented-host and loopback traffic passes, and an
 *     allowed undocumented host fails.
 *
 * Run: npx tsx tests/online-egress.ts  (no external network)
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { EgressEvent } from "../support/egress.ts";

const run = promisify(execFile);
const SUITE = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "online-egress-"));
process.env.RESULTS_DIR = scratch;
process.env.EGRESS_INFO = join(scratch, "egress.json");

const { Case } = await import("../journeys/harness.ts");
const { assertOnlineEgress, undocumentedHosts } = await import("../support/egress-policy.ts");
const { placeEgressMarker, readEgressEvents, setEgressMode, egressInfo } = await import("../support/egress.ts");

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`[${ok ? "ok" : "FAIL"}] ${name} — ${detail}`);
  if (!ok) failures += 1;
}

/** The online rule as c722ed79 shipped it: only allowed events were judged. */
function preFixOnlineOffenders(events: EgressEvent[]): string[] {
  return undocumentedHosts(events.filter((event) => event.allowed !== false));
}

async function judge(name: string, events: EgressEvent[]): Promise<{ status: string; evidence: string }> {
  const case_ = new Case("online-egress-test", name, ["egress witness"]);
  const status = await case_.run(async () => assertOnlineEgress(case_, events, "the window"));
  process.exitCode = 0; // expected failures set it; this test judges below
  const receipt = JSON.parse(await readFile(join(scratch, "receipts", `online-egress-test--${name}.json`), "utf8"));
  return { status, evidence: JSON.stringify(receipt.claims) };
}

const proxy = spawn(process.execPath, ["support/egress.mjs"], {
  cwd: SUITE,
  env: { ...process.env, EGRESS_LOG: join(scratch, "egress.jsonl"), EGRESS_INFO: process.env.EGRESS_INFO },
  stdio: "ignore",
});
try {
  for (let i = 0; i < 100; i += 1) {
    const ready = await readFile(process.env.EGRESS_INFO, "utf8").then(() => true, () => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const { proxy: proxyUrl } = egressInfo();
  await setEgressMode("online");
  const marker = await placeEgressMarker("refused-online-attempts");
  // Each destination is refused before the proxy opens an upstream socket.
  for (const url of [
    "https://discord.com/api/v10/channels/1/messages",
    "https://s3.amazonaws.com/datasets.huggingface.co/datasets/datasets/x/x.py",
    "http://cogportal.example/api/v1/local-reports",
  ]) {
    await run("curl", ["-sS", "-o", "/dev/null", "--max-time", "10", "--proxy", proxyUrl, url]).catch(() => undefined);
  }
  const window = (await readEgressEvents(marker)).filter((event) => event.kind !== "mode");
  const refusedHosts = window.filter((event) => event.allowed === false).map((event) => event.host);
  check(
    "the proxy recorded and refused all three online attempts",
    ["discord.com", "s3.amazonaws.com", "cogportal.example"].every((host) => refusedHosts.includes(host)) &&
      window.every((event) => event.kind === "connect" || event.kind === "http"),
    `refused: ${refusedHosts.join(", ")}; event kinds: ${[...new Set(window.map((event) => event.kind))].join(", ")}`,
  );

  check(
    "red: the pre-fix online rule passes the refused window",
    preFixOnlineOffenders(window).length === 0,
    `pre-fix offenders: ${JSON.stringify(preFixOnlineOffenders(window))}`,
  );

  const refused = await judge("refused-attempts", window);
  check(
    "green: assertOnlineEgress fails the journey case on refused attempts",
    refused.status === "FAIL" &&
      ["discord.com (refused)", "s3.amazonaws.com (refused)", "cogportal.example (refused)"].every((text) =>
        refused.evidence.includes(text),
      ),
    `status ${refused.status}; ${refused.evidence.slice(0, 400)}`,
  );

  const documented: EgressEvent[] = [
    { seq: 1, at: "t", mode: "online", kind: "connect", method: "CONNECT", host: "huggingface.co", port: 443, allowed: true },
    { seq: 2, at: "t", mode: "online", kind: "tunnel-bytes", host: "huggingface.co", sent: 900, received: 52_000 },
    { seq: 3, at: "t", mode: "online", kind: "connect", method: "CONNECT", host: "cas-bridge.xethub.hf.co", port: 443, allowed: true },
    { seq: 4, at: "t", mode: "online", kind: "http", method: "GET", host: "127.0.0.1", port: 8787, allowed: true },
  ];
  const clean = await judge("documented-and-loopback", documented);
  check("a documented-host and loopback window passes", clean.status === "PASS", `status ${clean.status}`);

  const allowedForeign: EgressEvent[] = [
    ...documented,
    { seq: 5, at: "t", mode: "online", kind: "connect", method: "CONNECT", host: "telemetry.example", port: 443, allowed: true },
  ];
  const foreign = await judge("allowed-undocumented", allowedForeign);
  check(
    "an allowed attempt to an undocumented host fails",
    foreign.status === "FAIL" && foreign.evidence.includes("telemetry.example (ALLOWED)"),
    `status ${foreign.status}`,
  );
} finally {
  proxy.kill("SIGTERM");
  await rm(scratch, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`online-egress: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("online-egress: all checks passed");
