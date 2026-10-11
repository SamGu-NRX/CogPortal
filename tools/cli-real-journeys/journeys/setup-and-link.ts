import { CliHome, env } from "../support/cli.ts";
import { Portal } from "../support/portal.ts";
import { readStackInfo } from "../support/stack-info.ts";
import { Case } from "./harness.ts";

/**
 * The setup journey, as a student meets it: sign in to the portal in a
 * browser, link the CLI from a terminal with that browser's approval, confirm
 * the link from both sides, then revoke it. Every step touches the real
 * Worker; nothing here reads a stub.
 */
const info = await readStackInfo();
const portal = await Portal.create();

const cases = {
  session: new Case("setup-and-link", "browser-session", ["portal Worker", "D1"]),
  deviceLink: new Case("setup-and-link", "device-link", ["portal Worker", "installed CLI", "shaper"]),
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

await cases.deviceLink.run(async () => {
  const case_ = cases.deviceLink;
  const home = await CliHome.create(env("VENV_WEEK1"));
  try {
    // link runs from HOME, outside any repository: the unlinked first-run
    // path. The printed verification URI carries the user code the browser
    // approves from.
    const link = home.start([
      "link",
      "--portal",
      info.shaperPortalOrigin,
      "--no-browser",
    ]);
    const printed = await link.waitFor(/user_code=([A-Za-z0-9-]+)/, 30_000);
    const userCode = printed[1];
    case_.claim(
      "the CLI printed a verification URI carrying a user code",
      `matched ${printed[0]}`,
    );
    const approval = await portal.approveDevice(userCode, "journey-laptop");
    case_.expect(
      approval === 200,
      "the browser session approved the device code",
      `POST /api/v1/cli/device/approve answered ${approval}`,
    );
    const exit = await link.exited(60_000);
    case_.expect(exit === 0, "the CLI linked after approval", `cogworks link exited ${exit}; output: ${link.output().slice(-400)}`);
    case_.expect(
      /Linked\./.test(link.output()),
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
  } finally {
    await home.close();
  }
});

await cases.revocation.run(async () => {
  const case_ = cases.revocation;
  const home = await CliHome.create(env("VENV_WEEK1"));
  try {
    const devices = await portal.cliDevices();
    const target = devices.find((device) => device.name === "journey-laptop");
    if (!target) {
      case_.blocked("no journey-laptop device found to revoke; the device-link case did not run first");
      return;
    }
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
  } finally {
    await home.close();
  }
});
