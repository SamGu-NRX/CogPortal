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

test("an oversized interaction body is refused before signature verification", async () => {
  const response = await worker.fetch(
    new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Length": String(1024 * 1024 + 1) },
      body: "x",
    }),
    env as never,
    { waitUntil() {} } as unknown as ExecutionContext,
  );
  assert.equal(response.status, 413);
});

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
