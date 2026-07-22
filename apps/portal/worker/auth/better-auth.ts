import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { D1Database, IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";
import type { Env } from "../env";
import { devAuthAvailable, githubConfigured } from "../env";

function assertAuthConfiguration(env: Env): void {
  const hasClientId = Boolean(env.GITHUB_CLIENT_ID);
  const hasClientSecret = Boolean(env.GITHUB_CLIENT_SECRET);
  if (hasClientId !== hasClientSecret) {
    throw new Error("GitHub OAuth requires both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.");
  }
  if (!hasClientId && !devAuthAvailable(env)) return;
  if (!env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is required when authentication is enabled.");
  }
  if (!env.BETTER_AUTH_URL) {
    throw new Error("BETTER_AUTH_URL is required when authentication is enabled.");
  }
  const url = new URL(env.BETTER_AUTH_URL);
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("BETTER_AUTH_URL must be an HTTPS origin (HTTP localhost is allowed).");
  }
}

export function requestCf(request: Request): IncomingRequestCfProperties | undefined {
  return (request as Request & { cf?: IncomingRequestCfProperties }).cf;
}

export function createAuth(
  env?: Env,
  cf?: IncomingRequestCfProperties,
  baseURL?: string,
) {
  if (env) assertAuthConfiguration(env);
  const db = env ? drizzle(env.DB as unknown as D1Database, { schema }) : ({} as never);
  const socialProviders =
    env && githubConfigured(env)
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
            overrideUserInfoOnSignIn: true,
            mapProfileToUser: (profile: { login: string }) => ({ githubLogin: profile.login }),
          },
        }
      : {};

  return betterAuth({
    // Keep OAuth callbacks on the configured origin rather than the request host.
    baseURL: env?.BETTER_AUTH_URL ?? baseURL ?? env?.PUBLIC_ORIGIN ?? "http://localhost",
    secret: env?.BETTER_AUTH_SECRET,
    disabledPaths: ["/update-user"],
    ...withCloudflare(
      {
        autoDetectIpAddress: true,
        geolocationTracking: false,
        cf: cf ?? {},
        d1: env ? { db, options: { usePlural: true } } : undefined,
      },
      {
        trustedOrigins: [
          env?.BETTER_AUTH_URL,
          env?.PUBLIC_ORIGIN,
          env?.ACTIVITY_ORIGIN,
          env?.ENVIRONMENT === "development" ? "http://localhost:5173" : undefined,
        ].filter((origin): origin is string => Boolean(origin)),
        emailAndPassword: { enabled: env ? devAuthAvailable(env) : false },
        socialProviders,
        rateLimit: {
          enabled: Boolean(env),
          storage: "database",
        },
        account: {
          encryptOAuthTokens: true,
          accountLinking: { enabled: false },
        },
        user: {
          additionalFields: {
            // Provider mapping requires input=true; /update-user is disabled above.
            githubLogin: { type: "string", required: false, input: true },
            cohortId: { type: "string", required: false, input: false },
            cohortJoinedAt: { type: "number", required: false, input: false },
          },
        },
      },
    ),
    // The CLI needs an adapter even though it never executes a database query.
    ...(env
      ? {}
      : {
          database: drizzleAdapter({} as D1Database, {
            provider: "sqlite",
            usePlural: true,
          }),
        }),
  });
}

export type Auth = ReturnType<typeof createAuth>;

export const auth = createAuth();

export async function getGithubToken(
  authInstance: Auth,
  userId: string,
  headers?: Headers,
): Promise<string | null> {
  try {
    const body = { providerId: "github", userId };
    // Passing headers switches Better Auth from trusted server mode to session auth.
    const result = headers
      ? await authInstance.api.getAccessToken({ body, headers })
      : await authInstance.api.getAccessToken({ body });
    return result?.accessToken ?? null;
  } catch {
    return null;
  }
}
