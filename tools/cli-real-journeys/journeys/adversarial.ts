import { generateKeyPairSync, webcrypto } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CliHome, env } from "../support/cli.ts";
import { TeamRepository } from "../support/git-fixture.ts";
import { Portal } from "../support/portal.ts";
import { readStackInfo } from "../support/stack-info.ts";
import { Case } from "./harness.ts";
import { SUBMISSION_PY } from "./submission.ts";

/**
 * The adversarial journey: the same real surfaces, wounded on purpose. The
 * shaper injects failures in front of the real Worker, and the cases hold the
 * CLI to graceful degradation and the bot to its signature gate. Every fault
 * is injected and cleared through the shaper's control plane, so the Worker
 * itself is never stubbed.
 */
const info = await readStackInfo();
const portal = await Portal.create();
// Approvals run from the same dev session a browser would hold; without it
// every approveDevice call answers 401.
await portal.devLogin("journey-student", { demo: true });
const BENCHMARK = "audio-identification";

/** Tells the shaper how the next `count` requests should fail, then clears it. */
async function shape(mode: "normal" | "fail_5xx" | "delay" | "drop", count = 1, ms = 30_000): Promise<void> {
  const response = await fetch(`${info.shaperControlOrigin}/__shape__`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, count, ms }),
  });
  if (response.status !== 200) {
    throw new Error(`shaper control answered ${response.status} for mode ${mode}`);
  }
}

async function latestReport(repoPath: string): Promise<Record<string, any>> {
  const dir = join(repoPath, ".cogbench", "reports");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  if (names.length === 0) throw new Error(`no saved reports under ${dir}`);
  return JSON.parse(await readFile(join(dir, names[names.length - 1]), "utf8"));
}

/** Links a fresh CLI HOME exactly as the student does. */
async function link(case_: Case, home: CliHome): Promise<void> {
  const link = home.start(["link", "--portal", info.shaperPortalOrigin, "--no-browser"]);
  const printed = await link.waitFor(/user_code=([A-Za-z0-9-]+)/, 30_000);
  let approved = await portal.approveDevice(printed[1], "journey-adversarial");
  if (approved >= 500) {
    // Same boot-settling retry as the benchmark journey; approve is
    // idempotent for the same user.
    approved = await portal.approveDevice(printed[1], "journey-adversarial");
  }
  case_.expect(approved === 200, "the device linked", `approve answered ${approved}`);
  const exit = await link.exited(60_000);
  case_.expect(exit === 0, "cogworks link exited cleanly", `exit ${exit}; output: ${link.output().slice(-400)}`);
}

/** The discord double's request log, parsed. The double records its own
 * `/__log__` reads too; those are instrumentation, not Discord traffic, so
 * they never count. */
async function doubleLog(): Promise<Array<Record<string, any>>> {
  const response = await fetch(`${info.discordDoubleOrigin}/__log__`);
  const entries = (await response.json()) as Array<Record<string, any>>;
  return entries.filter((entry) => entry.path !== "/__log__");
}

/** Signs `timestamp + body` with a PKCS8 Ed25519 private key, Discord's scheme. */
async function signInteraction(privateKey: webcrypto.CryptoKey, timestamp: string, body: string): Promise<string> {
  const data = new TextEncoder().encode(`${timestamp}${body}`);
  const signature = await webcrypto.subtle.sign("Ed25519", privateKey, data);
  return Buffer.from(signature).toString("hex");
}

async function importEd25519(pem: string): Promise<webcrypto.CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  return webcrypto.subtle.importKey("pkcs8", Buffer.from(pemBody, "base64"), { name: "Ed25519" }, false, ["sign"]);
}

/** Generates a fresh Ed25519 key that is NOT the bot's, for the forged case. */
async function strangerKey(): Promise<webcrypto.CryptoKey> {
  const { privateKey } = generateKeyPairSync("ed25519");
  return importEd25519(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
}

const cases = {
  syncFault: new Case("adversarial", "sync-fault-then-recover", ["shaper", "installed CLI", "portal Worker", "D1"]),
  liveFault: new Case("adversarial", "live-run-fault-degrades", ["shaper", "installed CLI", "portal Worker"]),
  forged: new Case("adversarial", "forged-interaction-rejected", ["CogBot", "Discord double"]),
  signed: new Case("adversarial", "signed-interaction-accepted", ["CogBot", "shaper"]),
};

await cases.syncFault.run(async () => {
  const case_ = cases.syncFault;
  const home = await CliHome.create(env("VENV_WEEK1"));
  const repo = await TeamRepository.create({
    originFullName: "cogworks-demo/vector-voyagers",
    files: { "submission.py": SUBMISSION_PY },
  });
  try {
    await link(case_, home);
    const run = home.start(["run", "--benchmark", BENCHMARK, "--json"], { cwd: repo.path });
    const runExit = await run.exited(900_000);
    case_.expect(runExit === 0, "the run that produces the report completed", `cogworks run exited ${runExit}`);
    const report = await latestReport(repo.path);
    const reportId = (report.id ?? report.reportId) as string;
    case_.claim("a real saved report exists to sync", String(reportId));

    await shape("fail_5xx", 3);
    const wounded = home.start(["sync"], { cwd: repo.path });
    const woundedExit = await wounded.exited(120_000);
    case_.command("cogworks sync (while the portal answers 500)", woundedExit, wounded.output());
    case_.expect(
      woundedExit !== 0,
      "sync failed when the portal returned 500s",
      `cogworks sync exited ${woundedExit}`,
    );
    case_.expect(
      /error|failed|portal/i.test(wounded.output()),
      "the failure message names the portal problem instead of crashing",
      wounded.output().slice(-400),
    );
    case_.expect(
      (await latestReport(repo.path)) !== undefined,
      "the report is still saved locally after the failed sync",
      `report ${reportId} still present under ${join(repo.path, ".cogbench", "reports")}`,
    );

    await shape("normal");
    const recovered = home.start(["sync"], { cwd: repo.path });
    const recoveredExit = await recovered.exited(120_000);
    case_.command("cogworks sync (after the fault cleared)", recoveredExit, recovered.output());
    case_.expect(recoveredExit === 0, "sync succeeded once the fault cleared", `exited ${recoveredExit}`);
    const reports = await portal.teamLocalReports(BENCHMARK);
    case_.expect(
      reports.some((row: any) => (row.id ?? row.reportId) === reportId),
      "the delayed report landed on the portal after recovery",
      `${reports.length} report(s) listed; looking for ${reportId}`,
    );
  } finally {
    await shape("normal");
    await home.close();
    await repo.dispose();
  }
});

await cases.liveFault.run(async () => {
  const case_ = cases.liveFault;
  const home = await CliHome.create(env("VENV_WEEK1"));
  const repo = await TeamRepository.create({
    originFullName: "cogworks-demo/vector-voyagers",
    files: { "submission.py": SUBMISSION_PY },
  });
  try {
    await link(case_, home);
    // Baseline: audio-identification ships inactive (0020 holds active=0
    // until a calibration ablation passes), so a healthy portal refuses the
    // live bubble and names the benchmark's state.
    const baseline = home.start(["run", "--benchmark", BENCHMARK, "--live", "--json"], { cwd: repo.path });
    const baselineExit = await baseline.exited(900_000);
    case_.command("cogworks run --live (healthy portal, inactive benchmark)", baselineExit, baseline.output());
    case_.expect(
      baselineExit !== 0 && /not active/i.test(baseline.output()),
      "a healthy portal refuses the inactive benchmark's live run by name",
      baseline.output().slice(-400),
    );

    // Faulted: the only variable now is the injected 503, so the failure
    // message must name the portal fault rather than the benchmark state.
    await shape("fail_5xx", 3);
    const run = home.start(["run", "--benchmark", BENCHMARK, "--live", "--json"], { cwd: repo.path });
    const exit = await run.exited(900_000);
    case_.command("cogworks run --live (while run creation answers 500)", exit, run.output());
    case_.expect(
      /HTTP 503/i.test(run.output()),
      "the degraded live run named the portal fault instead of the benchmark",
      run.output().slice(-400),
    );
    case_.expect(
      exit !== 0,
      "the degraded live run did not pretend the bubble succeeded",
      `exited ${exit}`,
    );
  } finally {
    await shape("normal");
    await home.close();
    await repo.dispose();
  }
});

await cases.forged.run(async () => {
  const case_ = cases.forged;
  const before = await doubleLog();
  const body = JSON.stringify({ type: 1 });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signInteraction(await strangerKey(), timestamp, body);
  const response = await fetch(`${info.shaperBotOrigin}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Signature-Ed25519": signature,
      "X-Signature-Timestamp": timestamp,
    },
    body,
  });
  case_.expect(
    response.status === 401,
    "the bot rejected an interaction signed by a stranger key",
    `POST / answered ${response.status} with a valid Ed25519 signature over the wrong key`,
  );
  const after = await doubleLog();
  case_.expect(
    after.length === before.length,
    "the rejected interaction produced no outbound Discord traffic",
    `double log stayed at ${after.length} requests`,
  );
});

await cases.signed.run(async () => {
  const case_ = cases.signed;
  const body = JSON.stringify({ type: 1 });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signInteraction(await importEd25519(info.discordPrivateKeyPem), timestamp, body);
  const response = await fetch(`${info.shaperBotOrigin}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Signature-Ed25519": signature,
      "X-Signature-Timestamp": timestamp,
    },
    body,
  });
  const responseBody = await response.text();
  case_.expect(
    response.status === 200,
    "the bot accepted the interaction signed with its own key",
    `POST / answered ${response.status}: ${responseBody.slice(0, 200)}`,
  );
  case_.expect(
    /"type":?\s*1/.test(responseBody),
    "the PONG came back, through the shaper, from the real verification path",
    responseBody.slice(0, 200),
  );
});
