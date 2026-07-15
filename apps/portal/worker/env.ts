import type { D1Database, Fetcher, Queue } from "@cloudflare/workers-types";
import type { RunJobV1 } from "@cogworks/contracts/protocol";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  DEV_AUTH: "enabled" | "disabled";
  EXECUTION_PROVIDER: "fixture" | "modal";
  PUBLIC_ORIGIN?: string;
  COURSE_GUILD_ID?: string;
  /** Secret used only for posting/editing team run bubbles via Discord REST. */
  DISCORD_BOT_TOKEN?: string;
  RUN_QUEUE?: Queue<RunJobV1>;
  MODAL_RUNNER_URL?: string;
  RUNNER_SIGNING_SECRET?: string;
  RUNNER_SIGNING_KEY_ID?: string;
  RUNNER_IMAGE_DIGEST?: string;
  RUNNER_PYTHON_VERSION?: string;
  RUN_STALE_AFTER_SECONDS?: string;

  // ── GitHub App (plan §6) — set via .dev.vars locally / secrets in prod.
  // When CLIENT_ID + CLIENT_SECRET are present, real OAuth sign-in and the
  // real GitHub client activate alongside the fixture repository.
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  /** Course template repo (owner/name). When set, connected repositories
   *  must be forks of it (fixture repo exempt). */
  GITHUB_TEMPLATE_REPO?: string;
  /** Immutable numeric ID of the canonical template repository. */
  GITHUB_TEMPLATE_REPO_ID?: string;

  /** Comma-separated GitHub logins with staff (TA/instructor) access.
   *  Platform role is derived from this list at request time — no DB state. */
  PLATFORM_STAFF_LOGINS?: string;
  /** Comma-separated GitHub logins shown as CogPortal owners. Owners also
   *  receive staff access, so the two allowlists need not be duplicated. */
  PLATFORM_OWNER_LOGINS?: string;
}

export function githubConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

export type AppEnv = { Bindings: Env };
