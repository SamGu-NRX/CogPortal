function bytesFromHex(value: string): Uint8Array | null {
  if (!/^[a-f0-9]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * How far a signed request's timestamp may sit from the Worker's clock, in seconds, either way.
 *
 * Discord signs the timestamp together with the body, but the signature alone never expires, so
 * without this bound a captured interaction could be replayed at any later time. Discord expects an
 * answer within 3 seconds and publishes no window of its own. Five minutes is a conventional
 * allowance for clock skew, chosen without measurement; nothing legitimate arrives that late.
 */
export const MAX_SIGNATURE_AGE_SECONDS = 300;

export async function verifyDiscordRequest(
  publicKeyHex: string,
  signatureHex: string | null,
  timestamp: string | null,
  body: ArrayBuffer,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!signatureHex || !timestamp) return false;
  // Discord sends whole Unix seconds. Anything else is not a timestamp we can bound.
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SIGNATURE_AGE_SECONDS) return false;
  const publicKey = bytesFromHex(publicKeyHex);
  const signature = bytesFromHex(signatureHex);
  if (!publicKey || publicKey.length !== 32 || !signature || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, "Ed25519", false, ["verify"]);
    const timestampBytes = new TextEncoder().encode(timestamp);
    const bodyBytes = new Uint8Array(body);
    const signed = new Uint8Array(timestampBytes.length + bodyBytes.length);
    signed.set(timestampBytes);
    signed.set(bodyBytes, timestampBytes.length);
    return crypto.subtle.verify("Ed25519", key, signature, signed);
  } catch {
    return false;
  }
}
