import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, env } from "../support/cli.ts";
import { readStackInfo } from "../support/stack-info.ts";
import { Case } from "./harness.ts";

/**
 * The device-name witness: python/cogbench's client sends
 * `{"deviceName": ...}` to `/api/v1/cli/device/start` (client.py,
 * start_device_link). The portal's start handler
 * (apps/portal/worker/routes/connections.ts:146-158) never reads that body:
 * it inserts the device authorization with device_name null, and the name is
 * only recorded later by the approve route.
 *
 * Two cases, so a broken read can never pass for the known defect:
 *   - start-row-readable (required): the start answered with a user code, the
 *     D1 read of that row succeeded, and exactly one row came back. A failed
 *     command, unparseable output, or a missing row fails it.
 *   - start-proposes-device-name (not required): the row's device_name is the
 *     proposed name. It fails while the portal drops the name. It only runs
 *     once the row was read; otherwise it records BLOCKED.
 *
 * The script exits 0 when both pass, 3 when only the known name drop fails,
 * and 1 for anything else, so run-all.sh can tell them apart.
 */
export interface WitnessDeps {
  /** POST the start proposal the way client.py does; return the raw exchange. */
  sendStart(origin: string, deviceName: string): Promise<{ status: number; body: string; userCode: string | null }>;
  /** Read the device_authorizations row for a user code; return the raw command outcome. */
  readAuthorization(userCode: string): Promise<{ exit: number; output: string }>;
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

  async readAuthorization(userCode) {
    // The run's own persistence root (run-all.sh exports SUITE_STATE): the
    // same D1 the booted stack serves.
    const sql = `select device_name from device_authorizations where user_code = '${userCode}'`;
    try {
      const result = await execFileP(
        "pnpm",
        ["exec", "wrangler", "d1", "execute", "cogportal-db", "--local", "--persist-to", env("SUITE_STATE"), "--command", sql, "--json"],
        { cwd: join(REPO_ROOT, "apps/portal"), timeout: 120_000 },
      );
      return { exit: 0, output: result.stdout };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        exit: typeof failure.code === "number" ? failure.code : 1,
        output: [failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n"),
      };
    }
  },
};

/**
 * The one device_authorizations row in `wrangler d1 execute --json` output.
 * Throws, naming what was wrong, on anything but exactly one row with a
 * device_name column.
 */
export function parseAuthorizationRow(stdout: string): { deviceName: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`the D1 read printed no JSON: ${JSON.stringify(stdout.slice(0, 200))}`);
  }
  const results = Array.isArray(parsed) ? (parsed[0] as { results?: unknown } | undefined)?.results : undefined;
  if (!Array.isArray(results)) throw new Error(`the D1 read's JSON has no results array: ${stdout.slice(0, 200)}`);
  if (results.length !== 1) throw new Error(`the D1 read returned ${results.length} row(s) for the user code; expected 1`);
  const row = results[0] as Record<string, unknown>;
  if (!("device_name" in row)) throw new Error(`the row has no device_name column: ${JSON.stringify(row)}`);
  const name = row.device_name;
  if (name !== null && typeof name !== "string") throw new Error(`device_name is neither text nor null: ${JSON.stringify(name)}`);
  return { deviceName: name };
}

export interface WitnessOutcome {
  read: string;
  name: string;
  exitCode: 0 | 1 | 3;
}

/** Runs both cases against the injected edges and writes their receipts. */
export async function runWitness(origin: string, deps: WitnessDeps): Promise<WitnessOutcome> {
  const readCase = new Case("device-name-witness", "start-row-readable", ["portal device authorization", "D1"]);
  const nameCase = new Case("device-name-witness", "start-proposes-device-name", ["portal device authorization"], {
    required: false,
  });
  const proposed = `witness-${process.platform}-${Date.now().toString(36)}`;
  let stored: { deviceName: string | null } | null = null;

  const read = await readCase.run(async () => {
    const sent = await deps.sendStart(origin, proposed);
    readCase.command(`POST /api/v1/cli/device/start {"deviceName": "${proposed}"}`, sent.status, sent.body);
    readCase.expect(
      sent.status === 200 && sent.userCode !== null,
      "the start endpoint minted a device authorization for the proposal",
      `status ${sent.status}; userCode ${sent.userCode ?? "absent"}`,
    );
    const userCode = sent.userCode ?? "";
    // The code goes into the read's SQL literal; only the stack's own code
    // shape may be interpolated.
    readCase.expect(
      /^[A-Za-z0-9-]+$/.test(userCode),
      "the user code is in the stack's own shape before the read interpolates it",
      `userCode ${JSON.stringify(userCode.slice(0, 40))}`,
    );
    const result = await deps.readAuthorization(userCode);
    readCase.command(
      `wrangler d1 execute cogportal-db --local --persist-to "$SUITE_STATE" --command "select device_name from device_authorizations where user_code = '<code>'" --json`,
      result.exit,
      result.output,
    );
    readCase.expect(result.exit === 0, "the D1 read of the authorization succeeded", `exit ${result.exit}: ${result.output.slice(0, 300)}`);
    let row: { deviceName: string | null };
    try {
      row = parseAuthorizationRow(result.output);
    } catch (error) {
      readCase.expect(false, "the D1 read returned exactly one authorization row", (error as Error).message);
      return;
    }
    stored = row;
    readCase.claim("the D1 read returned exactly one authorization row", `device_name: ${JSON.stringify(row.deviceName)}`);
  });

  const name = await nameCase.run(async () => {
    if (read !== "PASS" || stored === null) {
      nameCase.blocked("the authorization row was not read, so there is no name verdict (start-row-readable carries the failure)");
    }
    const row = stored as { deviceName: string | null };
    nameCase.expect(
      row.deviceName === proposed,
      "the start endpoint records the proposed device name (python/cogbench sends it; the portal stores it)",
      `stored device_name: ${row.deviceName === null ? "null" : JSON.stringify(row.deviceName)}; proposed: ${proposed}`,
    );
  });

  const exitCode = read === "PASS" && name === "PASS" ? 0 : read === "PASS" && name === "FAIL" ? 3 : 1;
  return { read, name, exitCode };
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  const info = await readStackInfo();
  const outcome = await runWitness(info.shaperPortalOrigin, portalDeps);
  process.exit(outcome.exitCode);
}
