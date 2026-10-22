import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Env } from "../worker/env.ts";

// Only the exported class bases need Workers stand-ins to load the real router.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export class WorkerEntrypoint{};export class DurableObject{};",
        shortCircuit: true,
        format: "module",
      };
    }
    return nextResolve(specifier, context);
  },
});
const { default: worker } = await import("../worker/index.ts");
const secret = "webhook-test-secret";
const env = {
  ENVIRONMENT: "development", DEV_AUTH: "enabled", EXECUTION_PROVIDER: "fixture",
  GITHUB_WEBHOOK_SECRET: secret,
  // Invalid auth configuration deliberately fails if auth construction is reached.
} as Env;

function oversized(path: string, max: number, framing: string): Request {
  const headers = new Headers();
  if (framing === "declared") headers.set("Content-Length", String(max + 1));
  if (framing === "understated") headers.set("Content-Length", "1");
  let remaining = framing === "declared" ? 1 : max + 1;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!remaining) { controller.close(); return; }
      const size = Math.min(remaining, 64 * 1024);
      controller.enqueue(new Uint8Array(size));
      remaining -= size;
    },
  });
  return new Request(`http://localhost${path}`, { method: "POST", headers, body, duplex: "half" } as RequestInit);
}

for (const [path, max] of [
  ["/api/github/webhook", 25_000_000],
  ["/api/auth/sign-in/email", 1024 * 1024],
] as const) {
  for (const framing of ["declared", "chunked", "understated"]) {
    test(`${path} rejects oversized ${framing} bodies before auth or signatures`, async (t) => {
      const sign = t.mock.method(crypto.subtle, "sign", async () => { throw new Error("signature work ran"); });
      t.mock.method(globalThis, "fetch", async () => { throw new Error("network must not run"); });
      const response = await worker.fetch(oversized(path, max, framing), env);
      assert.equal(response.status, 413);
      assert.equal(sign.mock.callCount(), 0);
    });
  }
}

test("GitHub verifies the original bytes, including a leading UTF-8 BOM", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("network must not run"); });
  const body = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const response = await worker.fetch(new Request("http://localhost/api/github/webhook", {
    method: "POST",
    headers: { "X-Hub-Signature-256": `sha256=${signature}`, "X-GitHub-Event": "ping" },
    body,
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
