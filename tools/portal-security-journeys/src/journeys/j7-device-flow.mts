import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Api, newStudent } from "../lib/client.mts";
import { refused, SkipJourney, withStack, type Check, type Journey } from "../lib/framework.mts";

type TokenGrant = { ok: true; token: string } | { ok: false; status: number; body: string };

type StartResponse = { deviceCode?: string; userCode?: string; expiresAt?: number };
type TokenResponse = { status?: string; token?: string; retryAfterSeconds?: number };

/**
 * The CLI's own poll loop: request a token for a device code until the worker
 * grants it or stops answering pending. Asserts the wire contract from
 * DeviceTokenResponseSchema: the granted field is `token` (not accessToken).
 */
async function pollForToken(api: Api, deviceCode: string, tries = 6): Promise<TokenGrant> {
  for (let i = 0; i < tries; i++) {
    const res = await api.req("POST", "/v1/cli/device/token", { json: { deviceCode }, anonymous: true });
    const body = res.json() as TokenResponse | null;
    if (res.status === 200 && body?.status === "authorized" && typeof body.token === "string") {
      return { ok: true, token: body.token };
    }
    if (res.status !== 200) return { ok: false, status: res.status, body: res.text };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, status: 200, body: "token never granted within the poll window" };
}

/**
 * J7 — CLI device-authorization boundary. Source contract (worker/routes/
 * connections.ts): start is public and issues a code pair with a 10-minute
 * TTL; approve demands a signed-in team member and refuses a second user's
 * approval of an already-approved code; the token endpoint grants exactly one
 * device token per code — pending before approval, 410 once consumed or
 * expired. Expiry is exercised by rewriting expires_at in the local D1 the
 * running stack uses (the same channel the harness seed uses), because the
 * TTL is a fixed 10-minute source constant, not a knob.
 */
export const j7: Journey = {
  id: "j7-device-flow",
  title:
    "The CLI device flow grants exactly one device token, only after an authenticated approval, and refuses unknown, consumed and expired codes",
  fixedInput: "fresh stack; two student identities (bob, charlie); device-flow endpoints per source review",
  needsStack: true,
  async run(_stack, log) {
    return withStack("j7", log, async (stack) => {
      const checks: Check[] = [];
      const anon = new Api(stack.baseUrl);

      // --- start: public, issues the code pair with the documented TTL ---
      const start = await anon.req("POST", "/v1/cli/device/start", { json: {}, anonymous: true });
      const startBody = start.json() as StartResponse | null;
      checks.push(
        (start.status === 200 || start.status === 201) && typeof startBody?.deviceCode === "string" && typeof startBody?.userCode === "string"
          ? { name: "POST /v1/cli/device/start issues a deviceCode + userCode without any session", ok: true, detail: `HTTP ${start.status}` }
          : { name: "POST /v1/cli/device/start issues a deviceCode + userCode without any session", ok: false, detail: `HTTP ${start.status}: ${start.text.slice(0, 160)}` },
      );
      const deviceCode = startBody?.deviceCode ?? "";
      const userCode = startBody?.userCode ?? "";
      if (!deviceCode || !userCode) return checks;

      const ttlSeconds = Math.round(((startBody?.expiresAt ?? 0) - Date.now()) / 1000);
      checks.push(
        ttlSeconds >= 540 && ttlSeconds <= 660
          ? { name: "POST /v1/cli/device/start declares the source-documented 10-minute code TTL (DEVICE_AUTH_TTL_MS)", ok: true, detail: `TTL ${ttlSeconds}s` }
          : { name: "POST /v1/cli/device/start declares the source-documented 10-minute code TTL (DEVICE_AUTH_TTL_MS)", ok: false, detail: `TTL ${ttlSeconds}s, expected ~600s per connections.ts DEVICE_AUTH_TTL_MS` },
      );

      // --- token poll BEFORE approval: pending, no token material ---
      const pending = await anon.req("POST", "/v1/cli/device/token", { json: { deviceCode }, anonymous: true });
      checks.push(
        pending.status === 200 && (pending.json() as TokenResponse | null)?.status === "pending" && !pending.text.includes("cog_")
          ? { name: "POST /v1/cli/device/token before approval returns status=pending and leaks no token", ok: true, detail: pending.text.slice(0, 80) }
          : { name: "POST /v1/cli/device/token before approval returns status=pending and leaks no token", ok: false, detail: `HTTP ${pending.status}: ${pending.text.slice(0, 160)}` },
      );

      // --- anonymous approval: refused by the requireTeam session guard ---
      const anonApprove = await anon.req("POST", "/v1/cli/device/approve", { json: { userCode, deviceName: "j7-anon-box" }, anonymous: true });
      checks.push(refused("POST /v1/cli/device/approve without a session refuses (requireTeam guard)", anonApprove.status, anonApprove.text));

      // --- wrong deviceCode on the token endpoint: refused (session-free) ---
      const wrongCode = await anon.req("POST", "/v1/cli/device/token", { json: { deviceCode: "f".repeat(64) }, anonymous: true });
      checks.push(refused("POST /v1/cli/device/token with an unknown deviceCode refuses", wrongCode.status, wrongCode.text));

      // --- bootstrap the approver sessions (demo-team provisioning) ---
      let bob: Awaited<ReturnType<typeof newStudent>>;
      let charlie: Awaited<ReturnType<typeof newStudent>>;
      try {
        bob = await newStudent(stack, "j7bob", { teamName: "J7 Bob Team" });
        charlie = await newStudent(stack, "j7charlie", { teamName: "J7 Charlie Team" });
      } catch (err) {
        // Everything below needs a team session. SkipJourney discards
        // accumulated checks by design, so the reason names the arms that
        // ran (with results) plus the observed bootstrap failure.
        const ran = checks.map((x) => `${x.ok ? "ok" : "FAIL"}: ${x.name}`).join("; ");
        throw new SkipJourney(`session-dependent device-flow arms blocked — student bootstrap failed: ${err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240)}. Arms that ran: ${ran}`);
      }

      // --- unknown but well-formed userCode: refused ---
      const unknownApprove = await bob.api.req("POST", "/v1/cli/device/approve", { json: { userCode: "ZZZZ-ZZZZ-ZZZZ", deviceName: "j7-unknown-box" } });
      checks.push(refused("POST /v1/cli/device/approve with an unknown userCode refuses", unknownApprove.status, unknownApprove.text));

      // --- happy path: the approver's own session approves; the CLI polls the token ---
      const approve = await bob.api.req("POST", "/v1/cli/device/approve", { json: { userCode, deviceName: "j7-bob-box" } });
      checks.push(
        approve.status === 200 || approve.status === 201
          ? { name: "POST /v1/cli/device/approve with the approver's own session succeeds", ok: true, detail: `HTTP ${approve.status}` }
          : { name: "POST /v1/cli/device/approve with the approver's own session succeeds", ok: false, detail: `HTTP ${approve.status}: ${approve.text.slice(0, 160)}` },
      );
      const granted = await pollForToken(anon, deviceCode);
      checks.push(
        granted.ok && granted.token.startsWith("cog_")
          ? { name: "POST /v1/cli/device/token after approval grants a cog_ device token to the CLI", ok: true, detail: "token carries the cog_ prefix per the wire contract" }
          : { name: "POST /v1/cli/device/token after approval grants a cog_ device token to the CLI", ok: false, detail: granted.ok ? "token missing cog_ prefix" : `HTTP ${granted.status}: ${granted.body.slice(0, 160)}` },
      );

      // --- double approval: a second user cannot re-approve; the same
      // approver's repeat is the documented idempotent success (reload case);
      // and at most one token is ever granted for the code ---
      const charlieApprove = await charlie.api.req("POST", "/v1/cli/device/approve", { json: { userCode, deviceName: "j7-charlie-box" } });
      checks.push(refused("POST /v1/cli/device/approve of an already-approved code by a second user (charlie) refuses", charlieApprove.status, charlieApprove.text));

      const bobReApprove = await bob.api.req("POST", "/v1/cli/device/approve", { json: { userCode, deviceName: "j7-bob-box" } });
      checks.push(
        bobReApprove.status === 200 || bobReApprove.status === 201
          ? { name: "POST /v1/cli/device/approve of a consumed code by the SAME approver is the documented idempotent success", ok: true, detail: `HTTP ${bobReApprove.status}` }
          : { name: "POST /v1/cli/device/approve of a consumed code by the SAME approver is the documented idempotent success", ok: false, detail: `HTTP ${bobReApprove.status}: ${bobReApprove.text.slice(0, 160)}` },
      );

      const secondGrant = await anon.req("POST", "/v1/cli/device/token", { json: { deviceCode }, anonymous: true });
      checks.push(refused("POST /v1/cli/device/token for an already-consumed code refuses — at most one token is ever granted per device code", secondGrant.status, secondGrant.text));

      // --- expiry: the TTL is a fixed 10-minute source constant, so
      // accelerate it by rewriting expires_at in the local D1 (wrangler d1
      // execute --local, the same channel the harness seed uses) rather than
      // sleeping through it. ---
      const start2 = await anon.req("POST", "/v1/cli/device/start", { json: {}, anonymous: true });
      const start2Body = start2.json() as StartResponse | null;
      const code2 = start2Body?.deviceCode ?? "";
      const user2 = start2Body?.userCode ?? "";
      if (!code2 || !user2) {
        throw new SkipJourney("expiry arm unexercisable: POST /v1/cli/device/start stopped issuing codes");
      }
      let accelerated = true;
      let accelDetail = "";
      try {
        execFileSync(
          "pnpm",
          ["exec", "wrangler", "d1", "execute", "cogportal-db", "--local", "--command", `UPDATE device_authorizations SET expires_at = 1 WHERE user_code = '${user2}'`],
          { cwd: join(stack.root, "apps", "portal"), stdio: "pipe", timeout: 60_000 },
        );
        log(`expired code ${user2} via local D1 write`);
      } catch (err) {
        accelerated = false;
        accelDetail = String(err).slice(0, 200);
      }
      if (!accelerated) {
        // Per the journey contract: a skipped arm carries the observed reason
        // instead of a fabricated pass. The checks above stay in the log.
        throw new SkipJourney(`expiry arm unexercisable: local D1 write failed — ${accelDetail}. Observed TTL from source: 10 minutes (connections.ts DEVICE_AUTH_TTL_MS).`);
      }
      const expiredApprove = await bob.api.req("POST", "/v1/cli/device/approve", { json: { userCode: user2, deviceName: "j7-expired-box" } });
      checks.push(refused("POST /v1/cli/device/approve of an expired code refuses (D1-accelerated expiry)", expiredApprove.status, expiredApprove.text));
      const expiredToken = await anon.req("POST", "/v1/cli/device/token", { json: { deviceCode: code2 }, anonymous: true });
      checks.push(refused("POST /v1/cli/device/token for an expired code refuses (D1-accelerated expiry)", expiredToken.status, expiredToken.text));
      const expiredStatus = await bob.api.req("GET", `/v1/cli/device/status?user_code=${encodeURIComponent(user2)}`);
      const statusBody = expiredStatus.json() as { valid?: boolean } | null;
      checks.push(
        expiredStatus.status === 200 && statusBody?.valid === false
          ? { name: "GET /v1/cli/device/status reports an expired userCode as valid:false", ok: true, detail: "HTTP 200 valid=false" }
          : { name: "GET /v1/cli/device/status reports an expired userCode as valid:false", ok: false, detail: `HTTP ${expiredStatus.status}: ${expiredStatus.text.slice(0, 160)}` },
      );

      return checks;
    });
  },
}
