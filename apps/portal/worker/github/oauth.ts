import type { Env } from "../env";
import { githubApiRequest } from "./client";

export const OAUTH_STATE_COOKIE = "cogportal_oauth_state";

export interface GitHubOAuthUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oauthConfig(env: Env): { clientId: string; clientSecret: string } {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new Error("GitHub OAuth is not configured.");
  }
  return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
}

export function githubCallbackUrl(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/api/github/callback`;
}

export function githubAuthorizeUrl(env: Env, redirectUri: string, state: string): string {
  const { clientId } = oauthConfig(env);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeOAuthCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<string> {
  const { clientId, clientSecret } = oauthConfig(env);
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "cogportal",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub OAuth failed with status ${response.status}.`);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.access_token !== "string") {
    throw new Error("GitHub OAuth did not return an access token.");
  }
  return payload.access_token;
}

export async function getGitHubOAuthUser(token: string): Promise<GitHubOAuthUser> {
  const response = await githubApiRequest("/user", token);
  if (!response.ok) throw new Error(`GitHub API request failed with status ${response.status}.`);
  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    typeof payload.id !== "number" ||
    typeof payload.login !== "string" ||
    (payload.name !== null && typeof payload.name !== "string") ||
    (payload.avatar_url !== null && typeof payload.avatar_url !== "string")
  ) {
    throw new Error("GitHub returned an invalid user.");
  }
  return {
    id: payload.id,
    login: payload.login,
    name: payload.name,
    avatarUrl: payload.avatar_url,
  };
}
