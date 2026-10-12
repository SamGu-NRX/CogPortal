/**
 * Mutation proof for the zero-request claim's detector. Replay:
 *   npx tsx support/zero-event-detector-probe.ts
 *
 * It plants a request to a DOCUMENTED public-asset host (github.com) in a
 * window that claims zero network requests — the exact mutation the old
 * undocumentedHosts check was blind to, because the host IS documented — and
 * shows a real journey Case FAILS on it. Removing the plant returns the case
 * to PASS. A refused event is also planted: any event fails a zero-request
 * claim, allowed or refused.
 *
 * The events are synthetic (same shapes the witness logs); no network is
 * touched. The in-suite equivalent — a real curl to a documented host
 * planted in the week2 witness-works window — runs in real-data-week2.ts.
 */

// real-data-common reads these at import; this probe never runs the CLI, so
// honest placeholder values are fine (all three PIN_* together, as the
// harness requires).
process.env.PIN_ID ??= "detector-probe";
process.env.PIN_REV ??= "detector-probe";
process.env.PIN_SOURCE ??= "detector-probe";
process.env.VENV_MATRIX ??= "detector-probe";
process.env.JOURNEY_HOME ??= "/tmp/zero-event-detector-probe-home";
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
process.env.RESULTS_DIR ??= mkdtempSync(join(tmpdir(), "zero-event-detector-probe-"));

const { Case } = await import("../journeys/harness.ts");
import type { EgressEvent } from "../support/egress.ts";
const common = await import("../journeys/real-data-common.ts");

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

/** A planted request to a DOCUMENTED host (allowed — that is the point) in an
 * offline window, exactly the event shapes the witness logs. */
const plantedDocumented: EgressEvent[] = [
  { seq: 1, at: "probe", mode: "offline", kind: "connect", method: "CONNECT", host: "github.com", port: 443, allowed: true },
  { seq: 2, at: "probe", mode: "offline", kind: "tunnel-bytes", host: "github.com", sent: 1907, received: 587886 },
];

/** A planted refused event (a non-documented attempt) — also a violation. */
const plantedRefused: EgressEvent[] = [
  { seq: 3, at: "probe", mode: "offline", kind: "connect", method: "CONNECT", host: "discord.com", port: 443, allowed: false, refused: "not a loopback or documented public-asset host" },
];

/** The case body a zero-request claim uses. */
async function zeroRequestCase(case_: InstanceType<typeof Case>, events: EgressEvent[]): Promise<void> {
  const violation = common.zeroRequestViolation(events);
  case_.expect(
    violation === null,
    "the offline check made zero network requests — any witnessed event, allowed or refused, fails the claim",
    violation ?? "the witness saw no events at all",
  );
}

// 1. The old check was blind to the mutation: the host is documented.
check(
  "old check (undocumentedHosts) passes the planted documented-host window — the defect",
  common.undocumentedHosts(plantedDocumented).length === 0,
  `undocumentedHosts=${JSON.stringify(common.undocumentedHosts(plantedDocumented))}`,
);

// 2. With the plant, a real Case FAILS.
const plantedCase = new Case("zero-event-detector-probe", "planted-documented-host-mutation", ["detector proof"]);
const plantedStatus = await plantedCase.run(async () => zeroRequestCase(plantedCase, plantedDocumented));
check(
  "planted documented-host request: the case FAILS",
  plantedStatus === "FAIL",
  `status=${plantedStatus}; detector=${common.zeroRequestViolation(plantedDocumented)}`,
);
process.exitCode = 0; // the expected failure set it; the probe judges below

// 3. A refused event alone also fails a zero-request claim.
const refusedCase = new Case("zero-event-detector-probe", "planted-refused-event-mutation", ["detector proof"]);
const refusedStatus = await refusedCase.run(async () => zeroRequestCase(refusedCase, plantedRefused));
check(
  "planted refused event: the case FAILS (any event, allowed or refused)",
  refusedStatus === "FAIL",
  `status=${refusedStatus}; detector=${common.zeroRequestViolation(plantedRefused)}`,
);
process.exitCode = 0;

// 4. Remove the plant: the same case PASSES on an empty window.
const cleanCase = new Case("zero-event-detector-probe", "zero-request-clean", ["detector proof"]);
const cleanStatus = await cleanCase.run(async () => zeroRequestCase(cleanCase, []));
check(
  "plant removed: the same zero-request case PASSES",
  cleanStatus === "PASS" && common.zeroRequestViolation([]) === null,
  `status=${cleanStatus}; detector=${common.zeroRequestViolation([])}`,
);

if (failures.length > 0) {
  console.error(`PROBE FAIL: ${failures.length} assertion(s) failed: ${failures.join("; ")}`);
  console.error(`receipts: ${process.env.RESULTS_DIR}/receipts`);
  process.exit(1);
}
console.log(`PROBE OK — mutation fails the case, clean window passes; receipts: ${process.env.RESULTS_DIR}/receipts`);
