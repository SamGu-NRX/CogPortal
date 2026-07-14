function bytesFromHex(value: string): Uint8Array | null {
  if (!/^[a-f0-9]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyDiscordRequest(
  publicKeyHex: string,
  signatureHex: string | null,
  timestamp: string | null,
  body: ArrayBuffer,
): Promise<boolean> {
  if (!signatureHex || !timestamp) return false;
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
