/**
 * Runner-callback signing, mirroring the worker's internal runner auth:
 * X-Cogworks-Key-Id, X-Cogworks-Timestamp, X-Cogworks-Signature = hex
 * HMAC-SHA256 over the byte string `<timestamp>.<rawBody>`.
 */
import { createHmac, createHash } from "node:crypto";

export function hmacSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function runnerHeaders(
  secret: string,
  rawBody: string,
  opts: { keyId?: string; timestamp?: string; signature?: string } = {},
): Record<string, string> {
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = opts.signature ?? hmacSignature(secret, timestamp, rawBody);
  return {
    "x-cogworks-key-id": opts.keyId ?? "primary",
    "x-cogworks-timestamp": timestamp,
    "x-cogworks-signature": signature,
    "content-type": "application/json",
  };
}

/** The test signing secret the harness writes into .dev.vars. */
export const RUNNER_SECRET = "runner-signing-secret-local-test";
