import type { Env } from "../env";

/**
 * The root every Discord call is built on: https://discord.com/api, with the
 * version (/v10) or the OAuth path (/oauth2/token) appended by the caller.
 *
 * DISCORD_API_BASE_URL replaces this root and nothing else. It is a test seam
 * for the real-journeys harness (tools/portal-real-journeys), which points it
 * at a loopback Discord double; no deployed environment sets it. It used to
 * be read as the versioned root by the bot clients and as the unversioned
 * root by the Activity exchange, so one override could not serve both.
 */
export function discordApiRoot(env: Pick<Env, "DISCORD_API_BASE_URL"> | undefined): string {
  return env?.DISCORD_API_BASE_URL?.length ? env.DISCORD_API_BASE_URL.replace(/\/+$/, "") : "https://discord.com/api";
}
