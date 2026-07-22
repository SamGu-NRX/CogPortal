import assert from "node:assert/strict";
import test from "node:test";
import type { Auth } from "../worker/auth/better-auth";
import { createAuth, getGithubToken } from "../worker/auth/better-auth";
import {
  accountLogin,
  githubAuthorizationLogin,
} from "../worker/auth/session";
import { rateLimits, schema } from "../worker/db/schema";
import type { Env } from "../worker/env";

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {},
    ENVIRONMENT: "development",
    DEV_AUTH: "enabled",
    EXECUTION_PROVIDER: "fixture",
    BETTER_AUTH_SECRET: "a-secure-development-secret-32-chars",
    BETTER_AUTH_URL: "http://localhost:5173",
    ...overrides,
  } as unknown as Env;
}

test("authentication configuration fails closed outside explicit development auth", () => {
  const production = createAuth(
    testEnv({ ENVIRONMENT: "production", DEV_AUTH: "enabled" }),
  );
  assert.equal(production.options.emailAndPassword?.enabled, false);

  assert.throws(
    () => createAuth(testEnv({ GITHUB_CLIENT_ID: "client-id" })),
    /requires both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET/,
  );
  assert.throws(
    () => createAuth(testEnv({ BETTER_AUTH_SECRET: undefined })),
    /BETTER_AUTH_SECRET is required/,
  );
  assert.throws(
    () =>
      createAuth(
        testEnv({
          GITHUB_CLIENT_ID: "client-id",
          GITHUB_CLIENT_SECRET: "client-secret",
          BETTER_AUTH_URL: "http://example.com",
        }),
      ),
    /must be an HTTPS origin/,
  );
});

test("GitHub profile mapping persists login without exposing user updates", async () => {
  const auth = createAuth(
    testEnv({
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
    }),
  );
  const github = auth.options.socialProviders?.github;
  assert.ok(github?.mapProfileToUser);
  assert.deepEqual(
    await github.mapProfileToUser({ login: "ada" }),
    { githubLogin: "ada" },
  );
  assert.equal(auth.options.user?.additionalFields?.githubLogin?.input, true);
  assert.deepEqual(auth.options.disabledPaths, ["/update-user"]);
  assert.equal(auth.options.rateLimit?.storage, "database");
  assert.equal(schema.rateLimits, rateLimits);
});

test("email-derived display names never become authorization identities", () => {
  const user = { githubLogin: null, email: "owner@dev.local" };
  assert.equal(accountLogin(user), "owner");
  assert.equal(githubAuthorizationLogin(user), "");
});

test("internal GitHub token lookups omit headers so userId authorizes the call", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const auth = {
    api: {
      getAccessToken: async (options: Record<string, unknown>) => {
        calls.push(options);
        return { accessToken: "github-token" };
      },
    },
  } as unknown as Auth;

  assert.equal(await getGithubToken(auth, "user-1"), "github-token");
  assert.deepEqual(calls, [{ body: { providerId: "github", userId: "user-1" } }]);
});

test("session-authorized GitHub token lookups preserve request headers", async () => {
  const headers = new Headers({ cookie: "better-auth.session_token=session" });
  const calls: Array<Record<string, unknown>> = [];
  const auth = {
    api: {
      getAccessToken: async (options: Record<string, unknown>) => {
        calls.push(options);
        return { accessToken: "github-token" };
      },
    },
  } as unknown as Auth;

  assert.equal(await getGithubToken(auth, "user-1", headers), "github-token");
  assert.equal(calls[0]?.headers, headers);
});

test("GitHub token lookup failures stay private and return null", async () => {
  const auth = {
    api: {
      getAccessToken: async () => {
        throw new Error("provider unavailable");
      },
    },
  } as unknown as Auth;

  assert.equal(await getGithubToken(auth, "user-1"), null);
});
