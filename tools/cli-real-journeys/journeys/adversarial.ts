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
 * CLI to graceful degradation, the bot to its signature gate, and one real
 * /cog command to the full round trip through the bot Worker to the Portal's
 * PortalRpc entrypoint. Every fault is injected and cleared through the
 * shaper's control plane, so the Worker itself is never stubbed.
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

// The reply flags CogBot sets on the message a student sees
// (packages/discord-kit/src/components.ts): private to the one student
// (EPHEMERAL, 1 << 6) and laid out as Components V2 (1 << 15).
const EPHEMERAL_FLAG = 1 << 6;
const COMPONENTS_V2_FLAG = 1 << 15;

/** Every `url` field in a Discord message's component tree; a link button
 * sits in an action row inside a container. */
function walkUrls(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(walkUrls);
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    const own = typeof record.url === "string" ? [record.url] : [];
    return [...own, ...Object.values(record).flatMap(walkUrls)];
  }
  return [];
}

const cases = {
  syncFault: new Case("adversarial", "sync-fault-then-recover", ["shaper", "installed CLI", "portal Worker", "D1"]),
  liveFault: new Case("adversarial", "live-run-fault-degrades", ["shaper", "installed CLI", "portal Worker"]),
  forged: new Case("adversarial", "forged-interaction-rejected", ["CogBot", "Discord double"]),
  signed: new Case("adversarial", "signed-interaction-accepted", ["CogBot", "shaper"]),
  cogCommand: new Case("adversarial", "cog-command-portal-roundtrip", ["CogBot", "portal Worker", "D1", "Discord double"]),
};

await cases.syncFault.run(async () => {
  const case_ = cases.syncFault;
  const home = await CliHome.create(env("VENV_WEEK1"));
  const repo = await TeamRepository.create({
    originFullName: "cogworks-demo/face-finder",
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
    const reports = [
      ...(await portal.teamLocalReports(BENCHMARK)),
      ...(await portal.teamUntrackedReports()),
    ];
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
    originFullName: "cogworks-demo/face-finder",
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

await cases.cogCommand.run(async () => {
  const case_ = cases.cogCommand;
  // A guild member the portal has never linked, unique per run so D1 state
  // that survived an earlier run can never turn this case down the linked
  // path. Everything about this identity is synthetic; the surfaces it
  // travels through are not.
  const discordUser = { id: `95${Date.now()}`, username: "journey_dc", global_name: "Journey Student" };
  const applicationId = "987654321098765432";
  const interactionToken = `journey${discordUser.id}`;
  const body = JSON.stringify({
    id: `96${Date.now()}`,
    application_id: applicationId,
    token: interactionToken,
    type: 2, // APPLICATION_COMMAND
    guild_id: info.courseGuildId,
    channel_id: "991234567890123456",
    data: { type: 1, name: "cog" }, // a plain CHAT_INPUT /cog, no options
    member: { user: discordUser },
  });
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
  const ack = (await response.json()) as { type?: number; data?: { flags?: number } };
  case_.expect(
    response.status === 200 && ack.type === 5 && ((ack.data?.flags ?? 0) & EPHEMERAL_FLAG) !== 0,
    "the bot acked the /cog interaction with a private deferred response, so the Portal RPC runs after the ack",
    `POST / answered ${response.status}: ${JSON.stringify(ack).slice(0, 200)}`,
  );

  // What the student sees back: the bot edits its deferred response through
  // the Discord REST API, which on this stack is the labelled double
  // (discord-api-double). The waitUntil work is asynchronous, so poll the
  // double's log for the PATCH of this interaction's followup.
  const webhookPath = `/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`;
  const deadline = Date.now() + 20_000;
  let followup: Record<string, any> | undefined;
  while (Date.now() < deadline && followup === undefined) {
    followup = (await doubleLog()).find((entry) => entry.method === "PATCH" && entry.path === webhookPath);
    if (followup === undefined) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const reply = followup?.body as { flags?: number; components?: unknown } | undefined;
  case_.expect(
    reply?.flags !== undefined,
    "the bot's deferred work came back as the followup the student sees, recorded by the discord-api-double",
    `PATCH ${webhookPath} ${reply ? "arrived" : "not found"} in the double's log`,
  );
  case_.expect(
    ((reply?.flags ?? 0) & EPHEMERAL_FLAG) !== 0 && ((reply?.flags ?? 0) & COMPONENTS_V2_FLAG) !== 0,
    "the reply the student sees is the bot's private Components-V2 message",
    `followup flags ${reply?.flags}`,
  );
  const replyText = JSON.stringify(reply?.components ?? []);
  case_.expect(
    replyText.includes("Hi Journey Student, I'm Cog"),
    "the reply greets the student with the display name the signed interaction carried",
    replyText.slice(0, 300),
  );

  const linkUrl = reply ? walkUrls(reply.components).find((url) => /\/connections#discord=[0-9a-f]{64}$/.test(url)) : undefined;
  case_.expect(
    linkUrl !== undefined,
    "the reply's next action is a one-time link button into Cog*Portal",
    replyText.slice(0, 300),
  );
  const portalHref = linkUrl !== undefined ? new URL(linkUrl) : undefined;
  case_.expect(
    portalHref?.origin === info.browsableOrigin,
    "the link button targets the portal itself, the origin a student browses",
    `${portalHref?.origin ?? "no link"} vs browsable ${info.browsableOrigin}`,
  );
  const linkToken = portalHref?.hash.startsWith("#discord=") ? portalHref.hash.slice("#discord=".length) : undefined;

  // What the Portal actually did: that token exists only if the bot's Portal
  // RPC (createDiscordLink) wrote a pending link row. The student's real
  // session, held through support/portal.ts, redeems it over the portal's
  // own HTTP API — the same calls the connections page makes.
  const preview = await portal.request("/api/v1/connections/discord/preview", {
    method: "POST",
    body: { token: linkToken },
  });
  const previewBody = preview.json() as { username?: string; expiresAt?: number };
  case_.expect(
    preview.status === 200 && previewBody.username === "Journey Student (@journey_dc)",
    "the portal holds the pending link the bot's RPC created, addressed to the interaction's Discord identity",
    `preview answered ${preview.status}: ${preview.body.slice(0, 200)}`,
  );
  case_.expect(
    typeof previewBody.expiresAt === "number" && previewBody.expiresAt > Date.now(),
    "the pending link is still inside its ten-minute window",
    `expiresAt ${previewBody.expiresAt}, now ${Date.now()}`,
  );
  const confirm = await portal.request("/api/v1/connections/discord/confirm", {
    method: "POST",
    body: { token: linkToken },
  });
  const confirmBody = confirm.json() as { discord?: { userId?: string; username?: string } };
  case_.expect(
    confirm.status === 200 &&
      confirmBody.discord?.userId === discordUser.id &&
      confirmBody.discord?.username === "Journey Student (@journey_dc)",
    "redeeming the link wrote the Discord account on the portal, tied to the interaction's user id",
    `confirm answered ${confirm.status}: ${confirm.body.slice(0, 200)}`,
  );
  // The synthetic identity was the case's own fixture; disconnecting it
  // leaves the portal as the case found it and keeps repeat runs on the
  // unlinked path the case is built around.
  const unlink = await portal.request("/api/v1/connections/discord", { method: "DELETE" });
  case_.expect(
    unlink.status === 200 && (unlink.json() as { discord?: unknown }).discord === null,
    "the case disconnected its synthetic identity, leaving no link behind",
    `DELETE /api/v1/connections/discord answered ${unlink.status}: ${unlink.body.slice(0, 200)}`,
  );
});
