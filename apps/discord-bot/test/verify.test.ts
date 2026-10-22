import assert from "node:assert/strict";
import test from "node:test";

import { MAX_SIGNATURE_AGE_SECONDS, verifyDiscordRequest } from "../src/verify.ts";

const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
const publicKeyHex = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
const body = new TextEncoder().encode(JSON.stringify({ type: 1 }));
const now = 1_800_000_000;

async function signed(timestamp: string, payload: Uint8Array = body): Promise<string> {
  const message = new Uint8Array([...new TextEncoder().encode(timestamp), ...payload]);
  return Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, message)).toString("hex");
}

async function accepts(timestamp: string): Promise<boolean> {
  return verifyDiscordRequest(publicKeyHex, await signed(timestamp), timestamp, body.buffer as ArrayBuffer, now);
}

test("a fresh signed request is accepted", async () => {
  assert.equal(await accepts(String(now)), true);
  assert.equal(await accepts(String(now - MAX_SIGNATURE_AGE_SECONDS)), true);
});

test("a validly signed request older than the window is refused, so a captured one can't be replayed", async () => {
  assert.equal(await accepts(String(now - MAX_SIGNATURE_AGE_SECONDS - 1)), false);
  assert.equal(await accepts("1750000000"), false);
});

test("a validly signed request dated in the future beyond the window is refused", async () => {
  assert.equal(await accepts(String(now + MAX_SIGNATURE_AGE_SECONDS + 1)), false);
});

test("a timestamp that isn't whole seconds is refused even when signed", async () => {
  for (const timestamp of ["", "1.8e9", "abc", ` ${now}`, "-1"]) {
    assert.equal(await accepts(timestamp), false, JSON.stringify(timestamp));
  }
});

test("a changed body still fails the signature", async () => {
  const timestamp = String(now);
  const signature = await signed(timestamp);
  const other = new TextEncoder().encode(JSON.stringify({ type: 2 }));
  assert.equal(await verifyDiscordRequest(publicKeyHex, signature, timestamp, other.buffer as ArrayBuffer, now), false);
});
