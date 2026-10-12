import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CheckFailure, Case } from "../journeys/harness.ts";
import { portalDeps, witnessBody, type WitnessDeps } from "../journeys/device-name-witness.ts";

/**
 * The device-name witness's own contract, driven over real loopback HTTP:
 * against a portal double that drops the proposed device name (the way
 * apps/portal's start endpoint inserts device_name null without reading the
 * request body), the witness must FAIL for that exact reason; against one
 * that records the proposal, it must pass. The real portal's edge is bound
 * in the journey itself; this test binds the same assertions to doubles.
 */

let failures = 0;
function check(name: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`[ok] ${name} — ${detail}`);
  } else {
    console.error(`[FAIL] ${name} — ${detail}`);
    failures += 1;
  }
}

interface StartDouble {
  origin: string;
  close(): Promise<void>;
}

/** A portal start double: mints a user code, records or drops the proposal. */
async function startDouble(honorProposal: boolean): Promise<StartDouble> {
  const stored = new Map<string, string | null>();
  const server: Server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/v1/cli/device/start") {
      let raw = "";
      request.on("data", (chunk: Buffer) => {
        raw += chunk;
      });
      request.on("end", () => {
        const userCode = `TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        // The defect's exact shape: the start endpoint never reads the body,
        // so the row's device_name is null; the honoring double stands in
        // for the fixed portal, which would record the proposal.
        stored.set(userCode, honorProposal && raw.includes("deviceName") ? (JSON.parse(raw) as { deviceName: string }).deviceName : null);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            deviceCode: "d".repeat(64),
            userCode,
            verificationUri: "http://127.0.0.1/connections",
            expiresAt: Date.now() + 600_000,
            pollIntervalSeconds: 5,
          }),
        );
      });
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/stored")) {
      const userCode = new URL(request.url, "http://x").searchParams.get("userCode") ?? "";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ device_name: stored.get(userCode) ?? null }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function doubleDeps(double: StartDouble): WitnessDeps {
  return {
    sendStart: portalDeps.sendStart,
    async storedDeviceName(userCode) {
      const response = await fetch(`${double.origin}/stored?userCode=${encodeURIComponent(userCode)}`);
      const body = await response.text();
      return { stored: (JSON.parse(body) as { device_name: string | null }).device_name, raw: body };
    },
  };
}

const ignoring = await startDouble(false);
const honoring = await startDouble(true);
try {
  {
    const case_ = new Case("device-name-witness-test", "ignoring-double", []);
    let message = "";
    try {
      await witnessBody(ignoring.origin, doubleDeps(ignoring), case_);
    } catch (error) {
      if (!(error instanceof CheckFailure)) throw error;
      message = error.message;
    }
    check(
      "against a portal that ignores the proposal, the witness fails",
      message.length > 0,
      message.length > 0 ? "witnessBody threw CheckFailure" : "witnessBody completed without failing",
    );
    check(
      "the failure names the device-name claim as the reason",
      message.includes("records the proposed device name") && message.includes("stored device_name: null"),
      message.slice(0, 200),
    );
  }
  {
    const case_ = new Case("device-name-witness-test", "honoring-double", []);
    let message = "";
    try {
      await witnessBody(honoring.origin, doubleDeps(honoring), case_);
    } catch (error) {
      if (!(error instanceof CheckFailure)) throw error;
      message = error.message;
    }
    check(
      "against a portal that records the proposal, the witness passes",
      message.length === 0,
      message.length === 0 ? "witnessBody completed with no CheckFailure" : message.slice(0, 200),
    );
  }
} finally {
  await ignoring.close();
  await honoring.close();
}

if (failures > 0) {
  console.error(`device-name-witness: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("device-name-witness: all checks passed");
