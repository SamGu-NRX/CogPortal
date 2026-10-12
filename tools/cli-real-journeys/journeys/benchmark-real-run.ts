import { webcrypto } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CliHome, env } from "../support/cli.ts";
import { TeamRepository } from "../support/git-fixture.ts";
import { Portal } from "../support/portal.ts";
import {
  findLiveRunSurface,
  liveSessionIds,
  primaryMetricOf,
  sameMetric,
  surfaceMismatch,
  type ShapedRequest,
} from "../support/surface-binding.ts";
import { readStackInfo } from "../support/stack-info.ts";
import { bindLiveBubble, type DoubleEntry } from "../support/live-bubble.ts";
import { Case } from "./harness.ts";
import { SUBMISSION_PY } from "./submission.ts";
import { LANGUAGE_SUBMISSION_PY } from "./submission-week3.ts";

/**
 * The benchmark journey, entirely real: a team repository with a working
 * Week 1 submission, the installed CLI scoring it against the benchmark's
 * own synthetic corpus, the report it saves, the sync that posts it to the
 * portal, and the live progress bubble the run sends to the course Discord
 * (observed on the loopback double).
 *
 * The submission is written for this suite in the shape the benchmark's
 * discovery accepts — a factory class with enroll/identify — adapted from
 * the fingerprint-matching pattern the benchmark's own reference tests use.
 */
const info = await readStackInfo();
const portal = await Portal.create();
// Approvals run from the same dev session a browser would hold; without it
// every approveDevice call answers 401.
await portal.devLogin("journey-student", { demo: true });
const BENCHMARK = "audio-identification";
const WEEK3_BENCHMARK = "language-search";

// ── Discord setup helpers for the channel-bind and live-run cases ──────────
// The journey forges the Discord side of the CogBot conversation exactly the
// way Discord would: signed interaction posts, and the double's log as the
// receipt of every view the bot rendered and every message it sent.

/** Signs `timestamp + body` with a PKCS8 Ed25519 private key, Discord's scheme. */
async function signInteraction(privateKey: webcrypto.CryptoKey, timestamp: string, body: string): Promise<string> {
  const data = new TextEncoder().encode(`${timestamp}${body}`);
  const signature = await webcrypto.subtle.sign("Ed25519", privateKey, data);
  return Buffer.from(signature).toString("hex");
}

async function importEd25519(pem: string): Promise<webcrypto.CryptoKey> {
  const pemBody = pem.replace(/-----BEGIN [A-Z ]+-----/, "").replace(/-----END [A-Z ]+-----/, "").replace(/\s+/g, "");
  return webcrypto.subtle.importKey("pkcs8", Buffer.from(pemBody, "base64"), { name: "Ed25519" }, false, ["sign"]);
}

/** The discord double's request log, minus its own /__log__ reads. */
async function doubleLog(): Promise<Array<Record<string, any>>> {
  const response = await fetch(`${info.discordDoubleOrigin}/__log__`);
  const entries = (await response.json()) as Array<Record<string, any>>;
  return entries.filter((entry) => entry.path !== "/__log__");
}

/** Waits until `probe` passes against a fresh double-log snapshot. */
async function waitForDouble(what: string, probe: (entries: Array<Record<string, any>>) => boolean, timeoutMs = 20_000): Promise<Array<Record<string, any>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = await doubleLog();
    if (probe(entries)) return entries;
    if (Date.now() > deadline) throw new Error(`the Discord double never showed ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Request lines the shaper recorded in front of the Workers after `after`. */
async function shapedRequestsAfter(after: number): Promise<ShapedRequest[]> {
  const response = await fetch(`${info.shaperControlOrigin}/__requests__?after=${after}`);
  if (!response.ok) throw new Error(`the shaper's request log answered ${response.status}`);
  return (await response.json()) as ShapedRequest[];
}

/** The newest recorded request's sequence number, or -1 before any. */
async function lastShapedRequestSeq(): Promise<number> {
  const all = await shapedRequestsAfter(-1);
  return all.length === 0 ? -1 : all[all.length - 1].seq;
}

let botKey: webcrypto.CryptoKey | null = null;

/** A signed interaction poster acting as one Discord user in the course
 * guild, talking to CogBot through the shaper. Answers the HTTP status. */
async function interactionPoster(discordUser: { id: string; username: string }, channelId: string) {
  botKey ??= await importEd25519(info.discordPrivateKeyPem);
  const key = botKey;
  return async (payload: Record<string, unknown>): Promise<number> => {
    const body = JSON.stringify({
      application_id: "journey-application",
      token: `journey-interaction-${discordUser.id}`,
      guild_id: info.courseGuildId,
      channel_id: channelId,
      member: { user: discordUser },
      ...payload,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(`${info.shaperBotOrigin}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Signature-Ed25519": await signInteraction(key, timestamp, body),
        "X-Signature-Timestamp": timestamp,
      },
      body,
    });
    return response.status;
  };
}

/** Links a fresh CLI HOME and approves it from the browser session. */
async function link(case_: Case, home: CliHome, deviceName: string): Promise<void> {
  const link = home.start(["link", "--portal", info.shaperPortalOrigin, "--no-browser"]);
  const printed = await link.waitFor(/user_code=([A-Za-z0-9-]+)/, 30_000);
  let approved = await portal.approveDevice(printed[1], deviceName);
  if (approved >= 500) {
    // One boot-settling retry: the first proxied request after the stack
    // comes up has once died with a 502 (socket hang up). The approve route
    // is idempotent for the same user, so a retry cannot double-approve.
    approved = await portal.approveDevice(printed[1], deviceName);
  }
  case_.expect(
    approved === 200,
    `the browser session approved device ${deviceName}`,
    `approve answered ${approved}`,
  );
  const exit = await link.exited(60_000);
  case_.expect(exit === 0, "the CLI linked", `cogworks link exited ${exit}; output: ${link.output().slice(-400)}`);
  case_.command("cogworks link --portal <shaper> --no-browser", exit, link.output());
}

/** The newest saved local report in the team repository, parsed. */
async function latestReport(repoPath: string): Promise<Record<string, any>> {
  const dir = join(repoPath, ".cogbench", "reports");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  if (names.length === 0) throw new Error(`no saved reports under ${dir}`);
  return JSON.parse(await readFile(join(dir, names[names.length - 1]), "utf8"));
}

/** The trailing JSON document in CLI output, parsed. The document may sit
 * after human-readable lines and contain nested objects, so scanning from
 * the last `{` (which is nested, not the document's start) fails; instead
 * try each `{` from the end and take the first suffix that parses whole. */
function trailingJson(text: string): any | null {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== "{") continue;
    try {
      return JSON.parse(text.slice(i));
    } catch {
      // keep scanning backwards
    }
  }
  return null;
}

const cases = {
  selfLink: new Case("benchmark-real-run", "self-link", ["portal Worker", "installed CLI"]),
  testSmall: new Case("benchmark-real-run", "test-small-case", ["installed CLI", "benchmark package", "team repo"]),
  runSync: new Case("benchmark-real-run", "run-and-sync", ["installed CLI", "benchmark package", "portal Worker", "D1"]),
  liveBubble: new Case("benchmark-real-run", "live-run-bubble", ["installed CLI", "portal Worker", "CogBot", "Discord double"]),
  discordBind: new Case("benchmark-real-run", "discord-channel-bind", ["portal Worker", "CogBot", "Discord double"]),
  liveLanguage: new Case("benchmark-real-run", "live-run-language-search", ["installed CLI", "benchmark package", "portal Worker", "D1", "CogBot", "Discord double"]),
};

await cases.selfLink.run(async () => {
  const case_ = cases.selfLink;
  const home = await CliHome.create(env("VENV_WEEK1"));
  try {
    await link(case_, home, "journey-bench");
    const devices = await portal.cliDevices();
    case_.expect(
      devices.some((device) => device.name === "journey-bench"),
      "the portal lists the benchmark journey's device",
      JSON.stringify(devices.map((device) => device.name)),
    );
  } finally {
    await home.close();
  }
});

await cases.testSmall.run(async () => {
  const case_ = cases.testSmall;
  const home = await CliHome.create(env("VENV_WEEK1"));
  const repo = await TeamRepository.create({
    originFullName: "cogworks-demo/face-finder",
    files: { "submission.py": SUBMISSION_PY },
  });
  try {
    await link(case_, home, "journey-bench");
    const test = home.start(["test", "--benchmark", BENCHMARK, "--json"], { cwd: repo.path });
    const exit = await test.exited(600_000);
    case_.command("cogworks test --benchmark audio-identification --json", exit, test.output());
    if (/not installed|ImportError|ModuleNotFoundError/.test(test.output()) && exit !== 0) {
      case_.blocked(`course environment missing a real dependency; CLI output ends: ${test.output().slice(-600)}`);
    }
    case_.expect(exit === 0, "the small-case run scored the submission", `cogworks test exited ${exit}`);
    const parsed = trailingJson(test.output());
    if (parsed === null) {
      case_.blocked(`--json output was not parseable; tail: ${test.output().slice(-400)}`);
    }
    case_.expect(
      parsed && typeof parsed === "object",
      "the test command returned a JSON report",
      `keys: ${parsed ? Object.keys(parsed).join(",") : "none"}`,
    );
  } finally {
    await home.close();
    await repo.dispose();
  }
});

await cases.runSync.run(async () => {
  const case_ = cases.runSync;
  const home = await CliHome.create(env("VENV_WEEK1"));
  const repo = await TeamRepository.create({
    originFullName: "cogworks-demo/face-finder",
    files: { "submission.py": SUBMISSION_PY },
  });
  try {
    await link(case_, home, "journey-bench");
    const run = home.start(["run", "--benchmark", BENCHMARK, "--json"], { cwd: repo.path });
    const exit = await run.exited(900_000);
    case_.command("cogworks run --benchmark audio-identification --json", exit, run.output());
    case_.expect(exit === 0, "the practice run completed", `cogworks run exited ${exit}`);
    const report = await latestReport(repo.path);
    case_.expect(
      Boolean(report.id ?? report.reportId),
      "the run saved a local report with an id",
      `report keys: ${Object.keys(report).slice(0, 12).join(",")}`,
    );
    const head = await repo.head();
    case_.claim("the team repository's HEAD the run pinned", head);

    const sync = home.start(["sync"], { cwd: repo.path });
    const syncExit = await sync.exited(120_000);
    case_.command("cogworks sync", syncExit, sync.output());
    case_.expect(syncExit === 0, "the saved report synced to the portal", `cogworks sync exited ${syncExit}`);

    // audio-identification ships inactive (0020 holds active=0 until a
    // calibration ablation passes), so the portal files its reports under the
    // untracked listing rather than the active-version team view. Either view
    // proves the sync persisted a team-scoped report.
    const reports = [
      ...(await portal.teamLocalReports(BENCHMARK)),
      ...(await portal.teamUntrackedReports()),
    ];
    const found = reports.find((row: any) => (row.id ?? row.reportId) === (report.id ?? report.reportId));
    case_.expect(
      Boolean(found),
      "the synced report appears in the team's portal view for the benchmark",
      `${reports.length} report(s) listed; looking for ${report.id ?? report.reportId}`,
    );
  } finally {
    await home.close();
    await repo.dispose();
  }
});

await cases.liveBubble.run(async () => {
  const case_ = cases.liveBubble;
  const home = await CliHome.create(env("VENV_WEEK1"));
  const repo = await TeamRepository.create({
    originFullName: "cogworks-demo/face-finder",
    files: { "submission.py": SUBMISSION_PY },
  });
  try {
    await link(case_, home, "journey-bench");
    // audio-identification ships inactive (0020_week1_audio.sql holds
    // active=0 on purpose until a calibration ablation passes), so the live
    // bubble is refused by design. This case pins the refusal contract:
    // nonzero exit and the benchmark's state named, with no fabricated
    // success. A live-run happy path needs an active-benchmark fixture.
    const run = home.start(["run", "--benchmark", BENCHMARK, "--live", "--json"], { cwd: repo.path });
    const exit = await run.exited(900_000);
    case_.command("cogworks run --benchmark audio-identification --live --json (inactive benchmark)", exit, run.output());
    case_.expect(
      exit !== 0 && /not active/i.test(run.output()),
      "the live run was refused with the benchmark's inactive state named",
      `exited ${exit}; output ends: ${run.output().slice(-300)}`,
    );
  } finally {
    await home.close();
    await repo.dispose();
  }
});

// The Discord setup journey, end to end: a signed /cog interaction mints the
// portal link, the portal session confirms it, the channel binds through the
// bot's confirmation interaction with the portal's real Discord validation
// reads behind it, and the bound view names the channel live runs bubble in.
// The link is revoked afterwards so the sequential adversarial journey's own
// link of this shared demo account cannot conflict.
await cases.discordBind.run(async () => {
  const case_ = cases.discordBind;
  const discordUser = { id: "9001000000000000001", username: "journey-student-discord" };
  const channelId = "9002000000000000001";
  const post = await interactionPoster(discordUser, channelId);
  // Cases share the double's accumulated log, and earlier cases' links are
  // spent; judge only entries this case's own /cog minted.
  const logBefore = (await doubleLog()).length;

  const cogStatus = await post({ type: 2, data: { id: "1", name: "cog", type: 1 } });
  case_.expect(cogStatus === 200, "the bot accepted the /cog interaction", `status ${cogStatus}`);
  const linkEntries = await waitForDouble(
    "the bot's connect view with a portal link token",
    (entries) =>
      entries
        .slice(logBefore)
        .some(
          (entry) => entry.method === "PATCH" && entry.path?.includes("/messages/@original") && JSON.stringify(entry.body ?? {}).includes("#discord="),
        ),
  );
  const token = [...JSON.stringify(linkEntries.slice(logBefore).map((entry) => entry.body ?? {})).matchAll(/#discord=([A-Za-z0-9_-]+)/g)].at(-1)?.[1];
  case_.expect(Boolean(token), "the bot's connect view carried a portal link token", "no #discord= token in any view edit");
  if (!token) throw new Error("the connect view never carried a #discord= token");

  const confirmed = await portal.confirmDiscordLink(token);
  // The bot's discordIdentity mints the display form ("@username" without a
  // global name) and the portal stores what the bot sent; match the userId
  // and that form, not the raw interaction username.
  case_.expect(
    confirmed.discord !== null && confirmed.discord.userId === discordUser.id && confirmed.discord.username === `@${discordUser.username}`,
    "the portal session confirmed the Discord link",
    JSON.stringify(confirmed).slice(0, 300),
  );

  // Linked: the /cog home view now offers binding this channel. Accept the
  // bind button, confirm the consent view, and wait for the bound home view
  // naming the channel — the portal's binding did real Discord validation
  // reads (channel, roles, bot member) against the double on the way.
  await post({ type: 2, data: { id: "2", name: "cog", type: 1 } });
  await waitForDouble("the bot's linked home view with a bind button", (entries) =>
    entries.some((entry) => entry.method === "PATCH" && entry.path?.includes("/messages/@original") && JSON.stringify(entry.body ?? {}).includes("cog:bind-channel")),
  );
  await post({ type: 3, data: { custom_id: "cog:bind-channel" }, message: { id: "m-journey", channel_id: channelId } });
  await waitForDouble("the bot's bind-consent view", (entries) =>
    entries.some((entry) => entry.method === "PATCH" && entry.path?.includes("/messages/@original") && JSON.stringify(entry.body ?? {}).includes("cog:bind-channel:confirm")),
  );
  await post({ type: 3, data: { custom_id: "cog:bind-channel:confirm" }, message: { id: "m-journey", channel_id: channelId } });
  const bound = await waitForDouble("the bot's bound home view naming the channel", (entries) =>
    entries.some((entry) => entry.method === "PATCH" && entry.path?.includes("/messages/@original") && JSON.stringify(entry.body ?? {}).includes(`Live runs → <#${channelId}>`)),
  );
  case_.claim("the bot's bound home view names the team channel", JSON.stringify(bound.map((entry) => entry.body)).slice(0, 600));

  const summary = await portal.connectionSummary();
  case_.expect(
    summary.discord !== null && summary.discord.userId === discordUser.id && summary.discord.username === `@${discordUser.username}`,
    "the portal session lists the linked Discord account",
    JSON.stringify(summary).slice(0, 300),
  );

  // Leave the shared demo account unlinked for the adversarial journey.
  await portal.revokeDiscordLink();
  const after = await portal.connectionSummary();
  case_.expect(after.discord === null, "the cleanup revoked the shared account's Discord link", JSON.stringify(after).slice(0, 300));
});

// The successful --live journey: the real Week 3 language-search benchmark —
// an active seeded version, unlike the deliberately inactive
// audio-identification — run live from a fresh CLI home. The run scores the
// checked-in reference submission against the checksum-pinned artifacts,
// reports through the portal, and the bound team channel receives the live
// progress bubble the CLI opens, all witnessed on the double.
await cases.liveLanguage.run(async () => {
  const case_ = cases.liveLanguage;
  const home = await CliHome.create(env("VENV_WEEK3"), { data: { languageData: env("WEEK3_DATA") } });
  const repo = await TeamRepository.create({
    originFullName: "cogworks-demo/face-finder",
    files: { "submission.py": LANGUAGE_SUBMISSION_PY },
  });
  try {
    await link(case_, home, "journey-bench");
    // The team's live bubble needs a bound channel: link the shared session's
    // Discord account and bind one. The discordBind case asserts every
    // intermediate view; here only the final bound state matters.
    const discordUser = { id: "9003000000000000001", username: "journey-student-discord" };
    const channelId = "9004000000000000001";
    const post = await interactionPoster(discordUser, channelId);
    // The channel-bind case's spent token is still in the double's
    // accumulated log; without the snapshot this probe answers instantly
    // with that token and the confirm dies with link_expired.
    const logBefore = (await doubleLog()).length;
    await post({ type: 2, data: { id: "1", name: "cog", type: 1 } });
    const linkEntries = await waitForDouble("the live journey's connect view token", (entries) =>
      entries
        .slice(logBefore)
        .some((entry) => entry.method === "PATCH" && entry.path?.includes("/messages/@original") && JSON.stringify(entry.body ?? {}).includes("#discord=")),
    );
    const token = [...JSON.stringify(linkEntries.slice(logBefore).map((entry) => entry.body ?? {})).matchAll(/#discord=([A-Za-z0-9_-]+)/g)].at(-1)?.[1];
    if (!token) throw new Error("the connect view never carried a #discord= token");
    const confirmed = await portal.confirmDiscordLink(token);
    case_.expect(
      confirmed.discord !== null && confirmed.discord.userId === discordUser.id,
      "the live journey's Discord link confirmed",
      JSON.stringify(confirmed).slice(0, 300),
    );
    await post({ type: 2, data: { id: "2", name: "cog", type: 1 } });
    await post({ type: 3, data: { custom_id: "cog:bind-channel" }, message: { id: "m-live", channel_id: channelId } });
    await post({ type: 3, data: { custom_id: "cog:bind-channel:confirm" }, message: { id: "m-live", channel_id: channelId } });
    await waitForDouble("the live journey's bound home view", (entries) =>
      entries.some((entry) => entry.method === "PATCH" && entry.path?.includes("/messages/@original") && JSON.stringify(entry.body ?? {}).includes(`Live runs → <#${channelId}>`)),
    );

    // The live run itself: the same shape as the refusal case, now against
    // the active benchmark — it must complete and save a report. The shaper's
    // request lines from here on carry the session id the CLI posts under.
    const requestMark = await lastShapedRequestSeq();
    const run = home.start(["run", "--benchmark", WEEK3_BENCHMARK, "--live", "--json"], { cwd: repo.path });
    const exit = await run.exited(900_000);
    case_.command("cogworks run --benchmark language-search --live --json", exit, run.output());
    case_.expect(exit === 0, "the live run completed", `cogworks run exited ${exit}; output ends: ${run.output().slice(-400)}`);
    const runRequests = await shapedRequestsAfter(requestMark);
    const sessions = liveSessionIds(runRequests);
    case_.expect(
      sessions.length === 1,
      "the live run posted its events under exactly one session",
      `sessions on the wire: ${JSON.stringify(sessions)}; ${runRequests.filter((request) => request.path.startsWith("/api/v1/local-runs")).length} local-runs request(s)`,
    );
    const sessionId = sessions[0];

    const report = await latestReport(repo.path);
    const reportId = report.id ?? report.reportId;
    case_.expect(Boolean(reportId), "the live run saved a local report with an id", `report keys: ${Object.keys(report).slice(0, 12).join(",")}`);
    const head = await repo.head();
    case_.claim("the team repository's HEAD the live run pinned", head);

    const sync = home.start(["sync"], { cwd: repo.path });
    const syncExit = await sync.exited(120_000);
    case_.command("cogworks sync", syncExit, sync.output());
    case_.expect(syncExit === 0, "the live report synced to the portal", `cogworks sync exited ${syncExit}`);

    const reports = [...(await portal.teamLocalReports(WEEK3_BENCHMARK)), ...(await portal.teamUntrackedReports())];
    const found = reports.find((row: any) => (row.id ?? row.reportId) === reportId);
    case_.expect(
      Boolean(found),
      "the live report appears in the team's portal view for the benchmark",
      `${reports.length} report(s) listed; looking for ${reportId}`,
    );

    // The snapshot never serializes the local report id, so the surface for
    // THIS run is the one whose localRunId is the session the CLI posted
    // under, at this benchmark and the pinned HEAD, finished with succeeded.
    // Its primary metric must then be the synced report's own.
    const surfaces = await portal.teamRunSurfaces();
    const identity = { benchmarkId: WEEK3_BENCHMARK, sha: head, sessionId };
    const surface = findLiveRunSurface(surfaces, identity);
    case_.expect(
      Boolean(surface),
      "the run surfaces this session's team-scoped live-run entry, finished succeeded",
      `${surfaces.length} surface(s) listed; looking for localRunId=${sessionId} stage=local benchmark=${WEEK3_BENCHMARK} sha=${head.slice(0, 7)} status=succeeded; ` +
        surfaces.map((row: any) => `${row?.id}: ${surfaceMismatch(row, identity) ?? "match"}`).join("; "),
    );
    const reportedPrimary = primaryMetricOf(report.metrics);
    const surfacedPrimary = primaryMetricOf(surface?.metrics);
    case_.expect(
      sameMetric(reportedPrimary, surfacedPrimary),
      "the surfaced live run carries the synced report's primary metric",
      `reported ${reportedPrimary?.key}=${reportedPrimary?.value}; surfaced ${surfacedPrimary?.key}=${surfacedPrimary?.value}`,
    );

    // The bound channel received THIS run's bubble: one create carrying this
    // surface's nonce, naming the benchmark and commit, then edits of that
    // same message ending on the finished view, and no traffic to any other
    // channel or message (support/live-bubble.ts). The portal publishes edits
    // in the background, so the newest edit can land after the CLI exits;
    // this waits up to 20 s for it and then judges the window it has.
    const expectation = {
      channelId,
      surfaceId: String(surface?.id ?? ""),
      benchmarkTitle: String(surface?.benchmark?.title ?? ""),
      shortSha: head.slice(0, 7),
    };
    let bubbleWindow: DoubleEntry[] = [];
    await waitForDouble("this run's finished bubble", (entries) => {
      bubbleWindow = entries.slice(logBefore);
      return bindLiveBubble(bubbleWindow, expectation).ok;
    }).catch(() => undefined);
    const bubble = bindLiveBubble(bubbleWindow, expectation);
    case_.expect(
      bubble.ok,
      `the bound channel ${channelId} received this run's bubble and its edits, and nothing else`,
      bubble.ok
        ? `create ${bubble.create?.path} -> message ${bubble.create?.messageId}; ${bubble.edits.length} edit(s) of it; newest shows Bench clear for ${expectation.shortSha}`
        : bubble.problems.join("; "),
    );

    await portal.revokeDiscordLink();
  } finally {
    // Best-effort: a mid-case failure must not leak this session's Discord
    // link into the later journeys' link_conflict. The happy path already
    // revoked above; this only runs when the case died between link and
    // revoke, or the stack is already gone.
    try {
      await portal.revokeDiscordLink();
    } catch {
      // Nothing to revoke, or the portal is unreachable at teardown.
    }
    await home.close();
    await repo.dispose();
  }
});


