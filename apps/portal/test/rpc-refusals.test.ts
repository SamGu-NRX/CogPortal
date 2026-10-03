import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { portalRefusal } from "@cogworks/contracts/discord";
import { cohorts, discordAccounts, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { Env } from "../worker/env.ts";
import { GitHubApiError } from "../worker/github/client.ts";
import { GITHUB_SIGN_IN_EXPIRED } from "../worker/http/errors.ts";
import { permissionCheckFailure } from "../worker/services/run-actions.ts";

/**
 * What leaves the portal when a Discord request fails.
 *
 * The bot shows a student the message of an error that arrives as an
 * ApiHttpError and a fixed "couldn't reach" line for anything else, so the
 * service binding is where "safe to show" is decided. These drive the real
 * `PortalRpc` class over the real migrations; only `cloudflare:workers`,
 * which exists only inside workerd, is stubbed to a constructor that keeps
 * `env` the way WorkerEntrypoint does.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export class WorkerEntrypoint{constructor(ctx,env){this.ctx=ctx;this.env=env}};export class DurableObject{};",
        shortCircuit: true,
        format: "module",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { PortalRpc } = await import("../worker/rpc.ts");

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
    if (/^(0002_seed|0016_backfill)/.test(file)) continue;
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let bound: never[] = [];
      const prepared = {
        bind(...params: unknown[]) {
          bound = params as never[];
          return prepared;
        },
        async run() {
          return { success: true, meta: statement.run(...bound) };
        },
        async all() {
          return { success: true, results: statement.all(...bound) };
        },
        async raw() {
          statement.setReturnArrays(true);
          const rows = statement.all(...bound);
          statement.setReturnArrays(false);
          return rows;
        },
      };
      return prepared;
    },
  };
}

async function seeded() {
  const binding = d1();
  const db = drizzle(binding as never);
  await db.insert(cohorts).values({ id: "cohort", slug: "c", name: "Cohort", joinCode: "CODE", active: true });
  await db.insert(users).values([
    { id: "user_ada", name: "Ada", email: "ada@example.test", githubLogin: "ada", cohortId: "cohort" },
  ]);
  const team = {
    cohortId: "cohort", description: null, repoOwner: "o", repoName: "r", repoFullName: "o/r",
    repoUrl: "https://github.com/o/r", defaultBranch: "main",
  };
  await db.insert(teams).values([
    { ...team, id: "team_ada", name: "Analytical Engines" },
    { ...team, id: "team_other", name: "Difference Engines", repoName: "s", repoFullName: "o/s", discordChannelId: CHANNEL },
  ]);
  await db.insert(teamMembers).values({ teamId: "team_ada", userId: "user_ada", role: "admin" });
  await db.insert(discordAccounts).values({ discordUserId: "discord_ada", userId: "user_ada", username: "ada", linkedAt: 1 });
  return binding;
}

function rpc(binding: unknown) {
  const env = { ENVIRONMENT: "development", COURSE_GUILD_ID: GUILD, DB: binding } as unknown as Env;
  return new PortalRpc({} as never, env);
}

test("a channel bound to another team is refused in a sentence the bot may show", async () => {
  const refused = await rpc(await seeded()).bindTeamChannel(GUILD, "discord_ada", CHANNEL).then(
    () => assert.fail("bound a channel another team owns"),
    (error: unknown) => error,
  );
  assert.deepEqual(portalRefusal(refused), {
    name: "ApiHttpError",
    code: "link_conflict",
    message:
      "That channel already belongs to Difference Engines. Open /cog in your own team's channel and choose it there.",
  });
});

test("a server outside the course is refused rather than reported as unreachable", async () => {
  const refused = await rpc(await seeded()).getTeamStatus("999999999999999999", "discord_ada").then(
    () => assert.fail("answered for another guild"),
    (error: unknown) => error,
  );
  assert.equal(portalRefusal(refused)?.code, "forbidden");
});

test("an internal failure crosses as a fixed sentence and keeps its detail in the log", async () => {
  const broken = {
    prepare() {
      throw new Error("D1_ERROR: no such table: discord_accounts: SQLITE_ERROR");
    },
  };
  const logged: string[] = [];
  const realError = console.error;
  console.error = (line: unknown) => logged.push(String(line));
  try {
    const failed = await rpc(broken).getTeamStatus(GUILD, "discord_ada").then(
      () => assert.fail("answered without a database"),
      (error: unknown) => error,
    );
    assert.ok(failed instanceof Error);
    assert.equal(failed.name, "Error");
    assert.equal(failed.message, "Cog*Portal could not complete that request.");
    assert.equal(portalRefusal(failed), null);
    assert.equal(Object.keys(failed).length, 0, "no own fields to carry internals across");
  } finally {
    console.error = realError;
  }
  assert.equal(logged.length, 1);
  assert.deepEqual(JSON.parse(logged[0]!), {
    event: "portal_rpc_failed",
    method: "getTeamStatus",
    message: "D1_ERROR: no such table: discord_accounts: SQLITE_ERROR",
  });
});

test("a GitHub permission lookup is refused for the reason GitHub gave", () => {
  const expired = permissionCheckFailure(new GitHubApiError(401));
  assert.deepEqual([expired.status, expired.code, expired.message], [403, "forbidden", GITHUB_SIGN_IN_EXPIRED]);

  for (const status of [403, 404]) {
    const lost = permissionCheckFailure(new GitHubApiError(status));
    assert.deepEqual(
      [lost.status, lost.code, lost.message],
      [403, "forbidden", "Current write permission to the connected repository is required."],
      `GitHub ${status}`,
    );
  }

  // None of these is about the student, so none of them says to sign in or
  // that access was lost. A rate limit can arrive as a 403.
  const limited = (status: number, headers: Record<string, string>) =>
    GitHubApiError.from(new Response(null, { status, headers }));
  assert.equal(limited(403, { "x-ratelimit-remaining": "0" }).rateLimited, true);
  assert.equal(limited(403, { "retry-after": "60" }).rateLimited, true);
  assert.equal(limited(403, { "x-ratelimit-remaining": "4999" }).rateLimited, false);
  for (const error of [
    new GitHubApiError(502),
    limited(429, {}),
    limited(403, { "x-ratelimit-remaining": "0" }),
    limited(403, { "retry-after": "60" }),
    new TypeError("fetch failed"),
    new Error("GitHub returned an invalid permission."),
  ]) {
    const transient = permissionCheckFailure(error);
    assert.deepEqual(
      [transient.status, transient.code, transient.message],
      [502, "provider_unconfigured", "GitHub didn't answer the write-access check, so this didn't go through. Try again in a moment."],
      error.message,
    );
  }
});
