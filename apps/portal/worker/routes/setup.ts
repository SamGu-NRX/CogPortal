import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  SETUP_STEPS,
  SetupStateSchema,
  SetupStepSchema,
  type SetupStep,
} from "@cogworks/contracts/schema";
import { requireTeam } from "../auth/session";
import { getDb } from "../db/client";
import { setupVerifications } from "../db/schema";
import type { AppEnv, Env } from "../env";
import { hmacSignature } from "../execution/runner";
import { ApiHttpError } from "../http/errors";
import { respond } from "../http/respond";
import { constantTimeTextEqual } from "../util/crypto";

const SETUP_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const SETUP_TOKEN_DOMAIN = "setup-v1";
const STALE_TOKEN_MESSAGE =
  "CogPortal: this check-off command is stale. Copy a fresh one from the setup page.";

const SetupTokenPayloadSchema = z
  .object({
    u: z.string().min(1),
    t: z.string().min(1),
    s: SetupStepSchema,
    exp: z.number().int(),
  })
  .strict();

type SetupTokenPayload = z.infer<typeof SetupTokenPayloadSchema>;

/** Any long-lived deployment secret works here: the HMAC is domain-separated
 *  ("setup-v1"), so reusing a secret from another subsystem is safe, and the
 *  fallback chain means a deployment with GitHub OAuth configured (i.e. any
 *  real one) can always sign check-off commands. */
function maybeSigningSecret(env: Env): string | undefined {
  return (
    env.ACTIVITY_SESSION_SECRET ||
    env.RUNNER_SIGNING_SECRET ||
    env.GITHUB_CLIENT_SECRET ||
    undefined
  );
}

function signingSecret(env: Env): string {
  const secret = maybeSigningSecret(env);
  if (!secret) {
    throw new ApiHttpError(
      501,
      "provider_unconfigured",
      "Setup command signing is not configured.",
    );
  }
  return secret;
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

function signatureBase64Url(signatureHex: string): string {
  const bytes = new Uint8Array(signatureHex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(signatureHex.slice(index * 2, index * 2 + 2), 16);
  }
  return base64Url(bytes);
}

async function signPayload(secret: string, payload: string): Promise<string> {
  return signatureBase64Url(await hmacSignature(secret, SETUP_TOKEN_DOMAIN, payload));
}

async function createSetupToken(secret: string, payload: SetupTokenPayload): Promise<string> {
  const encodedPayload = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encodedPayload}.${await signPayload(secret, encodedPayload)}`;
}

async function verifySetupToken(
  secret: string | undefined,
  token: string | undefined,
): Promise<SetupTokenPayload | null> {
  if (!secret || !token) return null;

  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [encodedPayload, suppliedSignature] = parts;
    if (!encodedPayload || !suppliedSignature) return null;

    const expectedSignature = await signPayload(secret, encodedPayload);
    if (!constantTimeTextEqual(expectedSignature, suppliedSignature)) return null;

    const decoded = new TextDecoder().decode(decodeBase64Url(encodedPayload));
    const payload = SetupTokenPayloadSchema.safeParse(JSON.parse(decoded));
    if (!payload.success || payload.data.exp <= Math.floor(Date.now() / 1_000)) return null;
    return payload.data;
  } catch {
    return null;
  }
}

async function setupTokens(
  secret: string,
  userId: string,
  teamId: string,
): Promise<Record<SetupStep, string>> {
  const exp = Math.floor(Date.now() / 1_000) + SETUP_TOKEN_TTL_SECONDS;
  const entries = await Promise.all(
    SETUP_STEPS.map(async (step) => [
      step,
      await createSetupToken(secret, { u: userId, t: teamId, s: step, exp }),
    ] as const),
  );
  return Object.fromEntries(entries) as Record<SetupStep, string>;
}

export function registerSetupRoutes(app: Hono<AppEnv>): void {
  app.get("/v1/setup/state", async (c) => {
    const auth = await requireTeam(c);
    const rows = await getDb(c.env)
      .select({ step: setupVerifications.step })
      .from(setupVerifications)
      .where(
        and(
          eq(setupVerifications.userId, auth.user.id),
          eq(setupVerifications.teamId, auth.team.id),
        ),
      );
    const verifiedSteps = new Set(
      rows.flatMap(({ step }) => {
        const parsed = SetupStepSchema.safeParse(step);
        return parsed.success ? [parsed.data] : [];
      }),
    );

    return respond(c, SetupStateSchema, {
      verified: SETUP_STEPS.filter((step) => verifiedSteps.has(step)),
      tokens: await setupTokens(signingSecret(c.env), auth.user.id, auth.team.id),
    });
  });

  app.get("/v1/setup/verify", async (c) => {
    const payload = await verifySetupToken(maybeSigningSecret(c.env), c.req.query("t"));
    if (!payload) return c.text(STALE_TOKEN_MESSAGE, 400);

    await getDb(c.env)
      .insert(setupVerifications)
      .values({
        userId: payload.u,
        teamId: payload.t,
        step: payload.s,
        verifiedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [
          setupVerifications.userId,
          setupVerifications.teamId,
          setupVerifications.step,
        ],
        set: { verifiedAt: Date.now() },
      });

    return c.text(
      `CogPortal: step '${payload.s}' is checked off. Back to the browser with you.`,
    );
  });
}
