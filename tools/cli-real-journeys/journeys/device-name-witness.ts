import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, env } from "../support/cli.ts";
import { readStackInfo } from "../support/stack-info.ts";
import { Case } from "./harness.ts";

/**
 * The device-name witness: python/cogbench's client sends
 * `{"deviceName": ...}` to `/api/v1/cli/device/start` so the registration
 * payload proposes the device's name (client.py's start_device_link, with the
 * CLI's own neutrality comment). The portal's start endpoint
 * (apps/portal/worker/routes/connections.ts) never reads that request body -
 * it inserts the device authorization with device_name null and the name is
 * only recorded later by the approve route. The proposal is dropped.
 *
 * This suite owns no portal files, so the witness is deliberately
 * non-required: it proves the drop with the stack's own D1 row and fails for
 * exactly that reason while the defect stands, the run bar stays green, and
 * the PR handoff carries the portal-side item for the web owner. If the
 * portal ever starts recording the proposal, this witness passes and the
 * handoff item can be closed.
 *
 * The HTTP send and the database read are injectable so the test can drive
 * the same assertions against loopback doubles of both edges.
 */
export interface WitnessDeps {
  /** POST the start proposal the way client.py does; return the raw exchange. */
  sendStart(origin: string, deviceName: string): Promise<{ status: number; body: string; userCode: string | null }>;
  /** Read back what the stack stored for the proposal's user code. */
  storedDeviceName(userCode: string): Promise<{ stored: string | null; raw: string }>;
}

const execFileP = promisify(execFile);

/** The real edges: the CLI's exact HTTP shape, and the stack's own D1 state. */
export const portalDeps: WitnessDeps = {
  async sendStart(origin, deviceName) {
    const response = await fetch(`${origin}/api/v1/cli/device/start`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ deviceName }),
    });
    const body = await response.text();
    let userCode: string | null = null;
    try {
      userCode = (JSON.parse(body) as { userCode?: string }).userCode ?? null;
    } catch {
      userCode = null;
    }
    return { status: response.status, body, userCode };
  },

  async storedDeviceName(userCode) {
    // The run's own persistence root (run-all.sh exports SUITE_STATE): the
    // same D1 the booted stack serves, read through wrangler the way the
    // run's migrate and seed steps write it.
    const sql = `select device_name from device_authorizations where user_code = '${userCode}'`;
    try {
      const result = await execFileP(
        "pnpm",
        ["exec", "wrangler", "d1", "execute", "cogportal-db", "--local", "--persist-to", env("SUITE_STATE"), "--command", sql, "--json"],
        { cwd: join(REPO_ROOT, "apps/portal"), timeout: 120_000 },
      );
      return { stored: parseStoredName(result.stdout), raw: result.stdout || result.stderr };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      const raw = failure.stdout || failure.stderr || failure.message || String(error);
      return { stored: null, raw: `wrangler d1 execute failed: ${raw.slice(0, 500)}` };
    }
  },
};

/** wrangler --json prints an array of execution results; the first row's device_name, else null. */
function parseStoredName(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as Array<{ results?: Array<{ device_name: string | null }> }>;
    return parsed[0]?.results?.[0]?.device_name ?? null;
  } catch {
    return null;
  }
}

/** The witness's assertions, bound to whatever edges the caller injected. */
export async function witnessBody(origin: string, deps: WitnessDeps, case_: Case): Promise<void> {
  const proposed = `witness-${process.platform}-${Date.now().toString(36)}`;
  const sent = await deps.sendStart(origin, proposed);
  case_.command(`POST /api/v1/cli/device/start {"deviceName": "${proposed}"}`, sent.status, sent.body);
  case_.expect(
    sent.status === 200 && sent.userCode !== null,
    "the start endpoint minted a device authorization for the proposal",
    `status ${sent.status}; userCode ${sent.userCode ?? "absent"}`,
  );
  const userCode = sent.userCode ?? "";
  // The code goes into the read's SQL literal; only our own stack's code
  // shape may be interpolated.
  case_.expect(
    /^[A-Za-z0-9-]+$/.test(userCode),
    "the user code is in the stack's own shape before the read interpolates it",
    `userCode ${JSON.stringify(userCode.slice(0, 40))}`,
  );
  const stored = await deps.storedDeviceName(userCode);
  case_.command(
    `wrangler d1 execute cogportal-db --local --persist-to "$SUITE_STATE" --command "select device_name from device_authorizations where user_code = '<code>'" --json`,
    0,
    stored.raw,
  );
  case_.expect(
    stored.stored === proposed,
    "the start endpoint records the proposed device name (python/cogbench sends it; the portal stores it)",
    `stored device_name: ${stored.stored === null ? "null" : JSON.stringify(stored.stored)}; proposed: ${proposed}`,
  );
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  const info = await readStackInfo();
  const case_ = new Case("device-name-witness", "start-proposes-device-name", ["portal device authorization"], {
    required: false,
  });
  await case_.run(() => witnessBody(info.shaperPortalOrigin, portalDeps, case_));
}
