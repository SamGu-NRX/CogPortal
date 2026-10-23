import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
const publicKeyHex = Buffer.from((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer).toString("hex");
const env = {
  DISCORD_PUBLIC_KEY: publicKeyHex,
  COURSE_GUILD_ID: "course",
  PORTAL_ORIGIN: "https://portal.example",
  PORTAL: undefined,
};

for (const framing of ["declared", "chunked", "understated"]) {
  test(`an oversized ${framing} interaction is refused before signature verification`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error("network must not run"); });
    const headers = new Headers();
    if (framing === "declared") headers.set("Content-Length", String(1024 * 1024 + 1));
    if (framing === "understated") headers.set("Content-Length", "1");
    let remaining = framing === "declared" ? 1 : 1024 * 1024 + 1;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!remaining) { controller.close(); return; }
        const size = Math.min(remaining, 64 * 1024);
        controller.enqueue(new Uint8Array(size));
        remaining -= size;
      },
    });
    const request = new Request("http://localhost", { method: "POST", headers, body, duplex: "half" } as RequestInit);
    const getHeader = request.headers.get.bind(request.headers);
    let signatureReads = 0;
    t.mock.method(request.headers, "get", (name: string) => {
      if (name.toLowerCase().startsWith("x-signature-")) signatureReads += 1;
      return getHeader(name);
    });
    const response = await worker.fetch(request, env as never, { waitUntil() {} } as unknown as ExecutionContext);
    assert.equal(response.status, 413);
    assert.equal(signatureReads, 0);
  });
}

test("a normal signed ping still succeeds", async () => {
  const body = JSON.stringify({ type: 1 });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signed = new Uint8Array([
    ...new TextEncoder().encode(timestamp),
    ...new TextEncoder().encode(body),
  ]);
  const signature = Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, signed)).toString("hex");
  const response = await worker.fetch(
    new Request("http://localhost", {
      method: "POST",
      headers: {
        "X-Signature-Ed25519": signature,
        "X-Signature-Timestamp": timestamp,
      },
      body,
    }),
    env as never,
    { waitUntil() {} } as unknown as ExecutionContext,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 1 });
});
