import { z } from "zod";
import { SetupStepSchema } from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { hmacSignature } from "../execution/runner";
import { constantTimeTextEqual } from "../util/crypto";

/**
 * The token behind the setup page's check-off command.
 *
 * It is a bearer capability worth one thing: recording one step, for one user,
 * one team and one benchmark, as self-reported. Both halves live here so the
 * side that mints and the side that verifies cannot drift apart, and so a test
 * can exercise the real pair rather than a copy of one of them.
 */

export const CHECK_OFF_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Bucketing the expiry keeps a token byte-identical for the day it was
 *  issued. The setup page refetches its state every 2.5 seconds while a step
 *  is outstanding, and an expiry taken from the clock made the copyable
 *  command rewrite itself under a student mid-selection. */
const EXPIRY_BUCKET_SECONDS = 24 * 60 * 60;

/** Signing context, so a signature made here is meaningless anywhere else. */
const PURPOSE = "cogportal/setup-check-off/v1";

export const STALE_TOKEN_MESSAGE =
  "CogPortal: this check-off command is stale. Copy a fresh one from the setup page.";

/** `b` is the benchmark the step was checked against, empty for a step that is
 *  about the machine rather than an environment. Signing it is what stops one
 *  track's check-off from ticking another's box. */
const CheckOffPayloadSchema = z
  .object({
    u: z.string().min(1),
    t: z.string().min(1),
    s: SetupStepSchema,
    b: z.string(),
    exp: z.number().int(),
  })
  .strict();

export type CheckOffPayload = z.infer<typeof CheckOffPayloadSchema>;

/**
 * The one secret this is allowed to use.
 *
 * A deployment can run without a runner, without Discord and without the
 * activity surface, but it cannot sign a student in without this, so a portal
 * that has a setup page to protect always has something to sign with. Earlier
 * versions fell back through `RUNNER_SIGNING_SECRET` and
 * `GITHUB_CLIENT_SECRET`; both are held by a third party (Modal has the first
 * byte for byte, GitHub issued the second), and either would have let that
 * party mint check-offs.
 *
 * Rotating this secret invalidates every command a student has already copied.
 * They see the stale sentence and take a fresh one off the page.
 */
export function maybeSigningSecret(env: Env): string | undefined {
  return env.BETTER_AUTH_SECRET || undefined;
}

/** A key for this purpose only, so the signature holds however the base secret
 *  is used elsewhere. Prefixing the payload would only hold while nothing else
 *  signs an attacker-chosen string under the same raw secret. */
async function purposeKey(secret: string): Promise<string> {
  return hmacSignature(secret, PURPOSE, "key");
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function sign(secret: string, encodedPayload: string): Promise<string> {
  const hex = await hmacSignature(await purposeKey(secret), PURPOSE, encodedPayload);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return base64Url(bytes);
}

/** Valid for at least the TTL and at most a day longer, and identical for
 *  every mint within the same day. */
export function checkOffExpiry(now = Date.now()): number {
  const day = Math.floor(now / 1_000 / EXPIRY_BUCKET_SECONDS);
  return (day + 1) * EXPIRY_BUCKET_SECONDS + CHECK_OFF_TTL_SECONDS;
}

export async function createCheckOffToken(
  secret: string,
  payload: CheckOffPayload,
): Promise<string> {
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encoded}.${await sign(secret, encoded)}`;
}

export async function readCheckOffToken(
  secret: string | undefined,
  token: string | undefined,
): Promise<CheckOffPayload | null> {
  if (!secret || !token) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [encoded, supplied] = parts;
    if (!encoded || !supplied) return null;
    // Signature before shape: nothing chosen by the caller is parsed until the
    // bytes are known to be ours.
    if (!constantTimeTextEqual(await sign(secret, encoded), supplied)) return null;
    const parsed = CheckOffPayloadSchema.safeParse(
      JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))),
    );
    if (!parsed.success || parsed.data.exp <= Math.floor(Date.now() / 1_000)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
