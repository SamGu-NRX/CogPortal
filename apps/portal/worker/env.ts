import type { D1Database, DurableObjectNamespace, Fetcher, Queue, R2Bucket } from "@cloudflare/workers-types";
import type { RunJobV1 } from "@cogworks/contracts/protocol";
import { createEnv, perRequestEnv } from "@cogworks/env";
import { z } from "zod";

export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  RUN_SURFACES: DurableObjectNamespace;
  ARTIFACTS: R2Bucket;
  RUN_QUEUE?: Queue<RunJobV1>;
}

const serverSchema = {
  ENVIRONMENT: z.enum(["development", "production"]),
  DEV_AUTH: z.enum(["enabled", "disabled"]),
  /** Owner-only setup controls, independent of the login provider. */
  ONBOARDING_DEV_TOOLS: z.enum(["enabled", "disabled"]).optional(),
  EXECUTION_PROVIDER: z.enum(["fixture", "modal"]),
  PUBLIC_ORIGIN: z.string().optional(),
  COURSE_GUILD_ID: z.string().optional(),
  /** Secret used only for posting/editing team run bubbles via Discord REST. */
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  ACTIVITY_SESSION_SECRET: z.string().optional(),
  ACTIVITY_ORIGIN: z.string().optional(),
  MODAL_RUNNER_URL: z.string().optional(),
  RUNNER_SIGNING_SECRET: z.string().optional(),
  RUNNER_SIGNING_KEY_ID: z.string().optional(),
  RUNNER_IMAGE_DIGEST: z.string().optional(),
  RUNNER_PYTHON_VERSION: z.string().optional(),
  RUN_STALE_AFTER_SECONDS: z.string().optional(),

  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  /** Course template repo (owner/name). When set, connected repositories must
   *  be forks of it (fixture repo exempt). */
  GITHUB_TEMPLATE_REPO: z.string().optional(),
  /** Immutable numeric ID of the canonical template repository. */
  GITHUB_TEMPLATE_REPO_ID: z.string().optional(),

  /**
   * Comma-separated GitHub logins of the platform's owners, matched
   * case-insensitively (auth/roles.ts).
   *
   * The only role that lives in configuration. Owners manage the staff roster,
   * which is the `platform_staff` table since migration 0031, so an owner list
   * the application could write would let anyone who reached that roster make
   * themselves an owner. Keeping it here also makes an empty roster
   * recoverable: owners receive staff access automatically, so somebody can
   * always add the first row.
   *
   * Optional, and an unset value means nobody is an owner. That is the correct
   * reading of "no owners were configured", and it fails closed.
   */
  PLATFORM_OWNER_LOGINS: z.string().optional(),

  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  /** Origin used to construct the fixed GitHub OAuth callback. */
  BETTER_AUTH_URL: z.url().optional(),
} satisfies Record<string, z.ZodType>;

export const validateServerEnv = perRequestEnv((runtimeEnv) =>
  createEnv({
    server: serverSchema,
    runtimeEnv,
    emptyStringAsUndefined: true,
    isServer: true,
  }),
);

export type ServerEnv = ReturnType<typeof validateServerEnv>;

export type Env = Bindings & ServerEnv;

export function githubConfigured(env: Env): env is Env & {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
} {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

export function onboardingDevToolsAvailable(env: Env): boolean {
  return env.ONBOARDING_DEV_TOOLS === "enabled";
}

export function devAuthAvailable(env: Env): boolean {
  return (
    env.ENVIRONMENT === "development" &&
    env.DEV_AUTH === "enabled" &&
    !githubConfigured(env)
  );
}

export type AppEnv = { Bindings: Env };
