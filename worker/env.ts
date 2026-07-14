import type { D1Database, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  DEV_AUTH: "enabled" | "disabled";
  EXECUTION_PROVIDER: "fixture" | "sandbox";

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
}

export function githubConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

export type AppEnv = { Bindings: Env };
