import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import {
  ConnectRepoRequestSchema,
  GithubInstallationSchema,
  GithubRepoSchema,
  SessionSchema,
} from "@cogworks/contracts/schema";
import type { GithubRepo } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { githubConfigured } from "../env";
import { authToSession, createSession, getAuth, requireUser } from "../auth/session";
import { getDb } from "../db/client";
import { teams, users } from "../db/schema";
import { FixtureGitHubClient, RealGitHubClient } from "../github/client";
import type { GitHubRepositoryListing } from "../github/client";
import { teamRole } from "../github/permissions";
import type { TeamRole } from "../github/permissions";
import { connectTeam, fixtureRepository } from "../github/team";
import type { ConnectRepository } from "../github/team";
import { validateTemplateRepository } from "../github/template";
import {
  OAUTH_STATE_COOKIE,
  exchangeOAuthCode,
  getGitHubOAuthUser,
  githubAuthorizeUrl,
  githubCallbackUrl,
} from "../github/oauth";
import { parseCogportalToml } from "../github/toml";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { newId, randomHex } from "../util/id";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ConnectRequestSchema = z.preprocess((value) => {
  if (isRecord(value) && typeof value.teamName === "string" && !value.teamName.trim()) {
    return { ...value, teamName: undefined };
  }
  return value;
}, ConnectRepoRequestSchema);

function bytesFromHex(value: string | undefined): Uint8Array | null {
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function registerGithubRoutes(app: Hono<AppEnv>): void {
  app.get("/github/login", (c) => {
    if (!githubConfigured(c.env)) {
      throw new ApiHttpError(404, "not_found", "GitHub sign-in is not configured.");
    }
    const state = randomHex(16);
    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
      secure: new URL(c.req.url).protocol === "https:",
    });
    return c.redirect(
      githubAuthorizeUrl(c.env, githubCallbackUrl(c.req.url), state),
      302,
    );
  });

  app.get("/github/callback", async (c) => {
    const clearState = (): void => {
      deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });
    };
    if (c.req.query("error") === "access_denied") {
      clearState();
      return c.redirect("/signin?error=oauth_denied", 302);
    }
    const state = c.req.query("state");
    const expectedState = getCookie(c, OAUTH_STATE_COOKIE);
    if (!state || !expectedState || state !== expectedState) {
      clearState();
      return c.redirect("/signin?error=oauth_failed", 302);
    }

    try {
      const code = c.req.query("code");
      if (!code || !githubConfigured(c.env)) throw new Error("OAuth callback is incomplete.");
      const oauthToken = await exchangeOAuthCode(c.env, code, githubCallbackUrl(c.req.url));
      const githubUser = await getGitHubOAuthUser(oauthToken);
      const db = getDb(c.env);
      let [user] = await db.select().from(users).where(eq(users.githubId, githubUser.id)).limit(1);
      if (!user) {
        [user] = await db
          .select()
          .from(users)
          .where(eq(users.githubLogin, githubUser.login))
          .limit(1);
      }
      const userId = user?.id ?? newId("user_");
      if (user) {
        await db
          .update(users)
          .set({
            githubId: githubUser.id,
            githubLogin: githubUser.login,
            name: githubUser.name,
            avatarUrl: githubUser.avatarUrl,
          })
          .where(eq(users.id, userId));
      } else {
        await db.insert(users).values({
          id: userId,
          githubId: githubUser.id,
          githubLogin: githubUser.login,
          name: githubUser.name,
          avatarUrl: githubUser.avatarUrl,
          cohortId: null,
          createdAt: Date.now(),
        });
      }
      await createSession(c, userId, oauthToken);
      clearState();
      return c.redirect("/", 302);
    } catch {
      clearState();
      return c.redirect("/signin?error=oauth_failed", 302);
    }
  });

  app.get("/github/repositories", async (c) => {
    const auth = await requireUser(c);
    const repositories: GitHubRepositoryListing[] = [];
    if (c.env.DEV_AUTH === "enabled") {
      repositories.push(...(await new FixtureGitHubClient().listRepositories()));
    }
    if (auth.oauthToken && githubConfigured(c.env)) {
      try {
        repositories.push(...(await new RealGitHubClient().listRepositories(auth.oauthToken)));
      } catch {
        console.warn(JSON.stringify({ evt: "github_api_failure", operation: "list_repositories" }));
      }
    }
    const claims = auth.cohort && repositories.length > 0
      ? await getDb(c.env)
          .select({ fullName: teams.repoFullName, teamName: teams.name })
          .from(teams)
          .where(
            and(
              eq(teams.cohortId, auth.cohort.id),
              inArray(
                teams.repoFullName,
                repositories.map((repository) => repository.fullName),
              ),
            ),
          )
      : [];
    const claimedByFullName = new Map(
      claims.map((claim) => [claim.fullName, claim.teamName]),
    );
    const payload: GithubRepo[] = repositories.map((repository) => ({
      ...repository,
      claimedByTeam: claimedByFullName.get(repository.fullName) ?? null,
    }));
    return respond(c, z.array(GithubRepoSchema), payload);
  });

  app.post("/github/connect", async (c) => {
    const auth = await requireUser(c);
    if (!auth.cohort) throw new ApiHttpError(403, "no_cohort", "Join a cohort first.");
    const body = await parseBody(c, ConnectRequestSchema);
    let repository: ConnectRepository;
    let permission: TeamRole;

    if (body.fullName === FIXTURE_REPO.fullName && c.env.DEV_AUTH === "enabled") {
      repository = fixtureRepository();
      permission = "write";
    } else {
      if (!githubConfigured(c.env) || !auth.oauthToken) {
        throw new ApiHttpError(
          403,
          "forbidden",
          "Sign in with GitHub to connect a repository.",
        );
      }
      const client = new RealGitHubClient();
      const githubRepository = await client.getRepo(body.fullName, auth.oauthToken);
      if (githubRepository.private) {
        throw new ApiHttpError(
          403,
          "forbidden",
          "Repositories must be public to run the benchmark.",
        );
      }
      const mappedPermission = teamRole(
        await client.getPermission(body.fullName, auth.user.githubLogin, auth.oauthToken),
      );
      if (!mappedPermission) {
        throw new ApiHttpError(
          403,
          "forbidden",
          "You need write access to run the benchmark for this repository.",
        );
      }
      validateTemplateRepository(c.env, githubRepository);
      const metadata = parseCogportalToml(
        (await client.getCogportalToml(body.fullName, auth.oauthToken)) ?? "",
      );
      repository = {
        id: githubRepository.id,
        sourceRepositoryId: githubRepository.sourceRepositoryId,
        owner: githubRepository.owner.login,
        name: githubRepository.name,
        fullName: `${githubRepository.owner.login}/${githubRepository.name}`,
        url: githubRepository.url,
        defaultBranch: githubRepository.defaultBranch,
        description: metadata.description ?? null,
      };
      permission = mappedPermission;
    }

    await connectTeam(
      getDb(c.env),
      auth.cohort.id,
      auth.user.id,
      repository,
      permission,
      body.teamName,
    );
    return respond(c, SessionSchema, authToSession(c.env, await getAuth(c)));
  });

  app.get("/github/installations", async (c) => {
    const auth = await requireUser(c);
    if (!githubConfigured(c.env) || !auth.oauthToken) {
      throw new ApiHttpError(
        403,
        "forbidden",
        "Sign in with GitHub to view installations.",
      );
    }
    const installations = await new RealGitHubClient().listInstallations(auth.oauthToken);
    return respond(c, z.array(GithubInstallationSchema), installations);
  });

  app.post("/github/webhook", async (c) => {
    const secret = c.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      throw new ApiHttpError(
        501,
        "provider_unconfigured",
        "GitHub App webhook is not configured in the fixture slice.",
      );
    }
    const body = await c.req.text();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    );
    const signature = c.req.header("X-Hub-Signature-256");
    const supplied = bytesFromHex(signature?.startsWith("sha256=") ? signature.slice(7) : undefined);
    const signatureMatches = constantTimeEqual(expected, supplied ?? new Uint8Array(expected.length));
    if (!supplied || !signatureMatches) {
      throw new ApiHttpError(401, "unauthorized", "Invalid webhook signature.");
    }

    const event = c.req.header("X-GitHub-Event") ?? "unknown";
    if (event === "ping") return c.json({ ok: true }, 200);
    console.log(
      JSON.stringify({
        evt: "github_webhook",
        event,
        delivery: c.req.header("X-GitHub-Delivery") ?? null,
      }),
    );
    return c.body(null, 204);
  });
}
