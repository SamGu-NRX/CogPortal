import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { SignInPage } from "../src/routes/SignInPage.tsx";
import { createAuth, requestCf } from "../worker/auth/better-auth.ts";
import type { Database } from "../worker/db/client.ts";
import { accounts, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { registerGithubRoutes } from "../worker/routes/github.ts";

/**
 * A GitHub sign-in refused on 2026-09-15 could not be explained afterwards.
 * Better Auth redirects to /signin?error=<code> and nothing else records a
 * failed callback, so once the page collapsed every code into "GitHub sign-in
 * failed. Try again." the reason was gone.
 *
 * The two halves have to agree, which is why they are tested together: the
 * callback test pins the code the deployed configuration emits for the row
 * shape production had, and the render test pins the sentence the page shows
 * for that code. Flipping account.accountLinking.enabled would change the
 * first and silently make the second's copy wrong.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const GITHUB_ID = 900001;
const GITHUB_LOGIN = "personal-account";
const GITHUB_EMAIL = "person@example.com";

function freshBinding(): unknown {
  const sqlite = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => !/^(0002_seed|0016_backfill)/.test(file));
  for (const file of files) sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));

  function prepare(query: string) {
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
  }
  return { prepare };
}

function stubGithub(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return new Response(
        JSON.stringify({ access_token: "gho_test", token_type: "bearer", scope: "read:user,user:email" }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://api.github.com/user") {
      return new Response(
        JSON.stringify({
          id: GITHUB_ID,
          login: GITHUB_LOGIN,
          name: "Person",
          email: GITHUB_EMAIL,
          avatar_url: null,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://api.github.com/user/emails") {
      return new Response(JSON.stringify([{ email: GITHUB_EMAIL, primary: true, verified: true }]), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unstubbed fetch: ${url}`);
  }) as typeof fetch;
}

async function signInWithGithub(seed: (db: Database) => Promise<void>): Promise<string> {
  const binding = freshBinding();
  const db = drizzle(binding as never) as unknown as Database;
  const env = {
    DB: binding,
    ENVIRONMENT: "production",
    DEV_AUTH: "disabled",
    EXECUTION_PROVIDER: "fixture",
    BETTER_AUTH_SECRET: "a-secure-development-secret-32-chars",
    BETTER_AUTH_URL: "http://localhost:5173",
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
  } as unknown as Env;
  await seed(db);

  const api = new Hono<AppEnv>();
  registerGithubRoutes(api);
  const app = new Hono<AppEnv>();
  app.all("/api/auth/*", (c) =>
    createAuth(c.env, requestCf(c.req.raw), new URL(c.req.url).origin).handler(c.req.raw),
  );
  app.route("/api", api);

  const start = await app.fetch(new Request("http://localhost:5173/api/github/login"), env);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const cookie = start.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");

  const callback = await app.fetch(
    new Request(`http://localhost:5173/api/auth/callback/github?code=test-code&state=${state}`, {
      headers: { cookie },
    }),
    env,
  );
  return callback.headers.get("location") ?? "";
}

function renderSignIn(location: string): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  client.setQueryData(["session"], {
    user: null,
    cohort: null,
    team: null,
    auth: {
      githubConfigured: true,
      devAuthEnabled: false,
      onboardingDevToolsEnabled: false,
      appSlug: null,
      templateRepo: null,
      executionProvider: "fixture",
    },
  });
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        StaticRouter as never,
        { location } as never,
        React.createElement(SignInPage),
      ),
    ),
  );
}

stubGithub();

test("a second GitHub account on an existing email is refused with account_not_linked", async () => {
  // The shape cogportal-db-prod was in on 2026-09-15: one user, already
  // holding a github account row for a different GitHub id.
  const redirect = await signInWithGithub(async (db) => {
    await db.insert(users).values({
      id: "user_existing",
      name: "Person",
      email: GITHUB_EMAIL,
      emailVerified: true,
      githubLogin: "work-account",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(accounts).values({
      id: "account_existing",
      accountId: "111111",
      providerId: "github",
      userId: "user_existing",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  assert.equal(redirect, "/signin?error=account_not_linked");
});

test("a first GitHub sign-in still succeeds", async () => {
  // The control: without it the assertion above would pass on a harness that
  // fails every sign-in.
  assert.equal(await signInWithGithub(async () => {}), "/signin");
});

test("the sign-in page names the refusal and keeps the code on screen", () => {
  const html = renderSignIn("/signin?error=account_not_linked");

  assert.match(html, /A Cog\*Portal account already uses that email/);
  assert.match(html, /Sign in with the GitHub account you used before/);
  assert.doesNotMatch(html, /GitHub sign-in failed/);
  // The code itself is what was missing on 2026-09-15.
  assert.match(html, /account_not_linked/);
});

test("a session that cannot be created says so rather than falling through", () => {
  // Better Auth emits this one from oauth2/link-account.mjs when createSession
  // returns nothing, so it needs its own sentence, not the generic one.
  const html = renderSignIn("/signin?error=unable_to_create_session");

  // Apostrophes arrive HTML-escaped, so the assertion avoids one.
  assert.match(html, /GitHub confirmed who you are/);
  assert.match(html, /start your session/);
  assert.doesNotMatch(html, /GitHub sign-in failed/);
  assert.match(html, /unable_to_create_session/);
});

test("an unrecognized code keeps the generic sentence and still shows the code", () => {
  // no_callback_url is emitted, but only ever by a misconfigured Worker, so it
  // is deliberately unlisted and lands here with its code visible.
  const html = renderSignIn("/signin?error=no_callback_url");

  assert.match(html, /GitHub sign-in failed. Try again./);
  assert.match(html, /no_callback_url/);
});

test("a code naming an inherited object property is unknown, not a crash", () => {
  // The code comes from the query string, so any string can arrive. A bare
  // lookup returned Object.prototype for __proto__, which React refuses to
  // render at all, and a function for constructor, which renders nothing.
  for (const code of ["__proto__", "constructor", "toString"]) {
    const html = renderSignIn(`/signin?error=${code}`);

    assert.match(html, /GitHub sign-in failed. Try again./);
  }
});
