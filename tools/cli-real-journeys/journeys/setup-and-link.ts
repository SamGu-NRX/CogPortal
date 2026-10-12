import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliHome, env } from "../support/cli.ts";
import { BrowserSession } from "../support/browser.ts";
import { Portal } from "../support/portal.ts";
import { readStackInfo } from "../support/stack-info.ts";
import { Case } from "./harness.ts";

/**
 * The setup journey, as a student meets it: sign in to the portal in a
 * browser, link the CLI from a terminal with that browser's approval, confirm
 * the link from both sides, then revoke it and make the stored credential
 * prove it is dead. Every step touches the real Worker; nothing here reads a
 * stub.
 */

/** The refusal `requireDevice` (apps/portal/worker/auth/device.ts) answers
 * with when the Bearer token hashes to no live device row — the case for a
 * token the browser session revoked: HTTP 401, code `invalid_token`, and this
 * message, through `handleError` → `errorResponse` as
 * `{"error":{"code","message"}}`. */
const REVOKED_TOKEN_REFUSAL = {
  status: 401,
  code: "invalid_token",
  message:
    "This CogWorks connection expired or was revoked. Run `cogworks link` to connect this machine again.",
} as const;

/** A minimal saved report, only so `cogworks sync` gets past its local "no
 * reports" preflight and actually POSTs. The portal refuses the request on
 * the token before it reads the body, so nothing here is a measurement: the
 * fields are exactly what LocalReport.from_json requires to parse, with
 * `weightsUsed: []` and no upload receipts so sync's local checks pass. */
const REVOCATION_REPORT_FIXTURE = {
  reportId: "local_revocation-fixture",
  benchmarkId: "journey-revocation",
  benchmarkVersion: 1,
  contractVersion: "0",
  sdkVersion: "0",
  pluginVersion: "0",
  dirty: false,
  startedAt: 0,
  finishedAt: 0,
  metrics: [],
  diagnostics: [],
  outputDigest: "revocation-fixture",
  weightsUsed: [],
};

/** The device token as the CLI stored it, read back out of the CliHome's
 * `~/.cogbench/config.json` — the same file `storage.config_path` resolves
 * for every CLI this HOME runs, so reuse means exactly the dead credential. */
async function storedDeviceToken(home: CliHome): Promise<string> {
  const path = join(home.path, ".cogbench", "config.json");
  const config = JSON.parse(await readFile(path, "utf8")) as {
    activePortal?: unknown;
    portals?: Record<string, { token?: unknown } | undefined>;
  };
  const entry = typeof config.activePortal === "string" ? config.portals?.[config.activePortal] : undefined;
  const token = entry?.token;
  if (typeof token !== "string" || !token.startsWith("cog_")) {
    throw new Error(`the CliHome stores no device token at ${path}`);
  }
  return token;
}

/** Asserts a portal answer is exactly the revoked-token refusal — status,
 * error code and message, each named on its own claim. */
function expectRevokedRefusal(
  case_: Case,
  response: { status: number; body: string },
  endpoint: string,
): void {
  let refusal: { code?: unknown; message?: unknown } | undefined;
  try {
    const parsed = JSON.parse(response.body) as { error?: { code?: unknown; message?: unknown } };
    refusal = parsed.error ? { code: parsed.error.code, message: parsed.error.message } : undefined;
  } catch {
    // Left undefined, the expects below name the unreadable body as evidence.
  }
  case_.expect(
    response.status === REVOKED_TOKEN_REFUSAL.status,
    `${endpoint} refuses the revoked token with HTTP ${REVOKED_TOKEN_REFUSAL.status}`,
    `${endpoint} answered ${response.status}: ${response.body.slice(0, 300)}`,
  );
  case_.expect(
    refusal?.code === REVOKED_TOKEN_REFUSAL.code,
    `${endpoint} refuses the revoked token with error code ${REVOKED_TOKEN_REFUSAL.code}`,
    `error code in the body: ${JSON.stringify(refusal?.code ?? null)}`,
  );
  case_.expect(
    refusal?.message === REVOKED_TOKEN_REFUSAL.message,
    `${endpoint} refuses the revoked token with the portal's message verbatim`,
    `error message in the body: ${JSON.stringify(refusal?.message ?? response.body.slice(0, 200))}`,
  );
}

const info = await readStackInfo();
const portal = await Portal.create();

const cases = {
  session: new Case("setup-and-link", "browser-session", ["portal Worker", "D1"]),
  deviceLink: new Case("setup-and-link", "device-link", ["portal Worker", "installed CLI", "shaper", "Portal SPA"]),
  revocation: new Case("setup-and-link", "device-revocation", ["portal Worker", "installed CLI"]),
};

await cases.session.run(async () => {
  const case_ = cases.session;
  const loginStatus = await portal.devLogin("journey-student", { demo: true });
  case_.expect(
    loginStatus === 200,
    "development sign-in created the session",
    `POST /api/dev/login answered ${loginStatus}`,
  );
  const session = await portal.session();
  const parsed = session.json() as { team?: unknown; user?: unknown };
  case_.expect(
    session.status === 200,
    "the session reports the signed-in student",
    `GET /api/session answered ${session.status}: ${session.body.slice(0, 400)}`,
  );
  case_.expect(
    Boolean(parsed.team),
    "the demo flag put the student on the seeded demo team",
    `session body team field: ${JSON.stringify(parsed.team ?? null).slice(0, 200)}`,
  );
});

// One CliHome serves both halves of the link lifecycle: the device-link case
// links from it, and the revocation case reuses the same stored credential
// after the browser revokes the device. A fresh HOME for the revocation case
// would hold no credential at all — the CLI would refuse locally with "not
// linked" and never reach the portal, which is exactly the gap this case
// exists to close.
let linkedHome: CliHome | undefined;

await cases.deviceLink.run(async () => {
  const case_ = cases.deviceLink;
  const home = await CliHome.create(env("VENV_WEEK1"));
  linkedHome = home;
  // link runs from HOME, outside any repository: the unlinked first-run
  // path. The printed line names the verification URI a student opens and
  // the code it carries; the browser acts on exactly what was printed.
  const link = home.start([
    "link",
    "--portal",
    info.shaperPortalOrigin,
    "--no-browser",
  ]);
  const printed = await link.waitFor(/Open (\S+) and confirm code ([A-Za-z0-9-]+)/, 30_000);
  const verificationUri = printed[1];
  const userCode = printed[2];
  case_.claim(
    "the CLI printed a verification URI carrying a user code",
    `matched ${printed[0]}`,
  );
  // The approval is a student act, not an API call: a real browser signs
  // in on the SPA, opens the printed link, and presses the page's own
  // button — once. No retries; the page offers exactly one approval and
  // this case asserts that one.
  const browserSession = await BrowserSession.start(info.browsableOrigin);
  try {
    const signedInAt = await browserSession.devSignIn("journey-student");
    case_.claim(
      "the SPA's development sign-in signed the browser in",
      `the sign-in form left the browser on ${signedInAt}`,
    );
    const approval = await browserSession.approveDevice(verificationUri, "journey-laptop", userCode);
    case_.expect(
      approval.shownCode === userCode,
      "the approval page showed the code the CLI printed",
      `the page showed ${approval.shownCode ?? "nothing"} for ${userCode} at ${approval.url}`,
    );
    case_.expect(
      approval.statusLine.includes("Device approved"),
      "the page's own Approve device button approved the link",
      `after the press the page said: ${approval.statusLine}`,
    );
  } finally {
    await browserSession.close();
  }
  const exit = await link.exited(60_000);
  case_.expect(exit === 0, "the CLI linked after approval", `cogworks link exited ${exit}; output: ${link.output().slice(-400)}`);
  case_.expect(
    /Linked\b/.test(link.output()),
    "the CLI said it linked",
    link.output().slice(-300),
  );
  case_.command("cogworks link --portal <shaper> --no-browser", exit, link.output());

  const status = home.start(["status"]);
  const statusExit = await status.exited(30_000);
  case_.expect(
    statusExit === 0 && /Device/.test(status.output()),
    "cogworks status shows the linked device",
    `exit ${statusExit}; output: ${status.output().slice(0, 400)}`,
  );
  case_.command("cogworks status", statusExit, status.output());

  const devices = await portal.cliDevices();
  case_.expect(
    devices.some((device) => device.name === "journey-laptop"),
    "the portal lists the approved device under the student's connections",
    `GET /api/v1/connections listed ${JSON.stringify(devices).slice(0, 400)}`,
  );
});

await cases.revocation.run(async () => {
  const case_ = cases.revocation;
  const home = linkedHome
    ?? case_.blocked("no linked CLI HOME to reuse; the device-link case did not run first");
  try {
    const devices = await portal.cliDevices();
    const target = devices.find((device) => device.name === "journey-laptop")
      ?? case_.blocked("no journey-laptop device found to revoke; the device-link case did not run first");
    const revoked = await portal.revokeDevice(target.id);
    case_.expect(
      revoked === 200,
      "the browser session revoked the device",
      `DELETE /api/v1/cli/devices answered ${revoked}`,
    );
    const after = await portal.cliDevices();
    case_.expect(
      !after.some((device) => device.id === target.id),
      "the revoked device no longer appears in the student's connections",
      `remaining devices: ${JSON.stringify(after).slice(0, 300)}`,
    );

    // Revocation is only half the story: the student's terminal still holds
    // the credential it linked with. It lives in this CliHome's stored
    // ~/.cogbench/config.json — the file every CLI started here resolves its
    // token from — so the reuse below presents exactly the dead credential.
    const token = await storedDeviceToken(home);
    case_.claim(
      "the linked HOME still stores the revoked credential",
      "read the device token back from the CliHome's .cogbench/config.json (token value withheld)",
    );

    // On the wire, the refusal both commands must meet — status asks
    // GET /api/v1/cli/device/status and sync POSTs /api/v1/local-reports,
    // both behind requireDevice. Assert status, error code and message
    // exactly; anything else would let a wrong refusal read as a pass.
    const statusRefusal = await portal.request("/api/v1/cli/device/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    expectRevokedRefusal(case_, statusRefusal, "GET /api/v1/cli/device/status");
    const syncRefusal = await portal.request("/api/v1/local-reports", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: REVOCATION_REPORT_FIXTURE,
    });
    expectRevokedRefusal(case_, syncRefusal, "POST /api/v1/local-reports");

    // The same refusal through the real CLI subprocesses, which read the
    // dead token out of the stored HOME state: sync needs a saved report to
    // get past its local preflight, so the fixture below is saved where
    // latest_report looks. The portal refuses on the token before it reads
    // the body, so the fixture's content is never a measurement.
    const reportDir = join(home.path, ".cogbench", "reports");
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      join(reportDir, "local_revocation-fixture.json"),
      JSON.stringify(REVOCATION_REPORT_FIXTURE),
    );
    const sync = home.start(["sync"]);
    const syncExit = await sync.exited(30_000);
    case_.command("cogworks sync (with the revoked credential)", syncExit, sync.output());
    case_.expect(
      syncExit !== 0,
      "cogworks sync fails on the revoked credential",
      `exit ${syncExit}; output: ${sync.output().slice(0, 400)}`,
    );
    case_.expect(
      sync.output().includes(REVOKED_TOKEN_REFUSAL.message),
      "cogworks sync reports the portal's revocation refusal verbatim",
      `output: ${sync.output().slice(-400)}`,
    );

    const status = home.start(["status"]);
    const statusExit = await status.exited(30_000);
    case_.command("cogworks status (with the revoked credential)", statusExit, status.output());
    case_.expect(
      statusExit !== 0,
      "cogworks status fails on the revoked credential",
      `exit ${statusExit}; output: ${status.output().slice(0, 400)}`,
    );
    case_.expect(
      status.output().includes(REVOKED_TOKEN_REFUSAL.message),
      "cogworks status reports the portal's revocation refusal verbatim",
      `output: ${status.output().slice(-400)}`,
    );
  } finally {
    await home.close();
  }
});
