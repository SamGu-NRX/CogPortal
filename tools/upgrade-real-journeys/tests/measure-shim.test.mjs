import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstrumentedViteConfig, writeShim } from "../lib/measure.mjs";

const RESPONSE_ECHO_URL = new URL("../.generated/response-echo.ts", import.meta.url);

function fakeCheckout() {
  const checkout = mkdtempSync(join(tmpdir(), "upgrade-suite-shim-"));
  mkdirSync(join(checkout, "apps", "portal", "worker"), { recursive: true });
  writeFileSync(join(checkout, "apps", "portal", "worker", "index.ts"), "export default { fetch() { return new Response('x'); } };\n");
  return checkout;
}

// The shim's response echo: plain responses get the measurement header, but
// WebSocket upgrades pass through untouched - a 101 is not a constructible
// status and rebuilding the response would drop the paired socket.
test("echoResponse replays plain responses with the measurement header", async () => {
  writeShim(fakeCheckout()); // (re)generates .generated/response-echo.ts
  const { echoResponse } = await import(RESPONSE_ECHO_URL.href);
  const res = new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  const out = echoResponse(res, 3);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("x-upgrade-suite-queries"), "3");
  assert.equal(await out.text(), "ok");
});

test("echoResponse passes WebSocket upgrades through untouched", async () => {
  writeShim(fakeCheckout());
  const { echoResponse } = await import(RESPONSE_ECHO_URL.href);
  const upgraded = { status: 101, webSocket: {}, headers: new Headers() };
  const out = echoResponse(upgraded, 3);
  assert.equal(out, upgraded);
  const accepted = { status: 200, webSocket: {}, headers: new Headers() };
  assert.equal(echoResponse(accepted, 0), accepted);
});

test("the generated vite config lives inside the portal package's resolution scope", () => {
  const checkout = fakeCheckout();
  const shim = writeShim(checkout);
  const cfg = writeInstrumentedViteConfig(checkout, shim);
  // Under the pnpm layout the plugins the config imports are declared only by
  // apps/portal, so the config must be generated inside that package.
  assert.ok(cfg.startsWith(join(checkout, "apps", "portal")));
  const text = readFileSync(cfg, "utf8");
  assert.ok(text.includes("@vitejs/plugin-react"));
  assert.ok(text.includes("@cloudflare/vite-plugin"));
  assert.ok(text.includes(shim));
});
