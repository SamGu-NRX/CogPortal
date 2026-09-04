import type { Hono } from "hono";
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
import { devAuthAvailable, githubConfigured } from "../env";
import { getGithubToken, getGithubTokenOrThrow } from "../auth/better-auth";
import {
  authFor,
  authToSession,
  forwardAuthCookies,
  getAuth,
  requireUser,
} from "../auth/session";
import { getDb } from "../db/client";
import { teams } from "../db/schema";
import { FixtureGitHubClient, RealGitHubClient } from "../github/client";
import type { GitHubRepositoryListing } from "../github/client";
import { teamRole } from "../github/permissions";
import type { TeamRole } from "../github/permissions";
import { connectTeam, fixtureRepository } from "../github/team";
import type { ConnectRepository } from "../github/team";
import { validateTemplateRepository } from "../github/template";
import { parseCogportalToml } from "../github/toml";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";

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
  app.get("/github/login", async (c) => {
    if (!githubConfigured(c.env)) {
      throw new ApiHttpError(404, "not_found", "GitHub sign-in is not configured.");
    }
    const result = await authFor(c).api.signInSocial({
      body: {
        provider: "github",
        // The sign-in page routes a signed-in user to their next stage (join,
        // connect, setup, dashboard) and to any pending connection return;
        // the marketing page does neither, so landing there after GitHub
        // left every new student on the front page with a signed-in header.
        callbackURL: "/signin",
        // Better Auth falls errorCallbackURL back to callbackURL, so without
        // this a failed or cancelled sign-in landed on the marketing page with
        // an ?error= nobody reads, and the student saw no explanation at all.
        // It appends ?error=<code>, which SignInPage renders.
        errorCallbackURL: "/signin",
      },
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    forwardAuthCookies(c, result.headers);
    if (!result.response.url) {
      throw new ApiHttpError(502, "provider_unconfigured", "GitHub sign-in did not return a redirect URL.");
    }
    return c.redirect(result.response.url, 302);
  });

  app.get("/github/repositories", async (c) => {
    const auth = await requireUser(c);
    const repositories: GitHubRepositoryListing[] = [];
    if (devAuthAvailable(c.env)) {
      repositories.push(...(await new FixtureGitHubClient().listRepositories()));
    }
    let githubToken: string | null = null;
    if (githubConfigured(c.env)) {
      try {
        githubToken = await getGithubTokenOrThrow(authFor(c), auth.user.id, c.req.raw.headers);
      } catch {
        // A failed token lookup is not "the user has no GitHub link": rendering
        // it as an empty list tells the student their fork is missing.
        console.warn(JSON.stringify({ evt: "github_api_failure", operation: "token_lookup" }));
        throw new ApiHttpError(
          502,
          "provider_unconfigured",
          "GitHub did not answer the repository listing. Try again shortly.",
        );
      }
    }
    if (githubToken) {
      try {
        repositories.push(...(await new RealGitHubClient().listRepositories(githubToken)));
      } catch {
        console.warn(JSON.stringify({ evt: "github_api_failure", operation: "list_repositories" }));
        // Swallowing this returned an empty success, and ConnectPage then
        // told the student their fork was missing during a GitHub outage.
        // Fixture repositories cannot soften it: devAuthAvailable requires
        // GitHub to be unconfigured, so this token and that path never
        // coexist. Fail the request; the page's error panel offers a retry.
        throw new ApiHttpError(
          502,
          "provider_unconfigured",
          "GitHub did not answer the repository listing. Try again shortly.",
        );
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
    // The one-team-per-user unique index would reject this connect anyway,
    // but as a raw 500. Refuse before any insert, with the join path's
    // sentence. This also closes the window where a team row was created
    // and the membership insert then failed, orphaning the claim.
    if (auth.team) {
      throw new ApiHttpError(409, "already_on_team", "You are already on a team.");
    }
    const body = await parseBody(c, ConnectRequestSchema);
    let repository: ConnectRepository;
    let permission: TeamRole;

    if (body.fullName === FIXTURE_REPO.fullName && devAuthAvailable(c.env)) {
      repository = fixtureRepository();
      permission = "write";
    } else {
      const githubToken = githubConfigured(c.env)
        ? await getGithubToken(authFor(c), auth.user.id, c.req.raw.headers)
        : null;
      const githubLogin = auth.user.githubLogin;
      if (!githubToken || !githubLogin) {
        throw new ApiHttpError(
          403,
          "forbidden",
          "Sign in with GitHub to connect a repository.",
        );
      }
      const client = new RealGitHubClient();
      const githubRepository = await client.getRepo(body.fullName, githubToken);
      if (githubRepository.private) {
        throw new ApiHttpError(
          403,
          "forbidden",
          "Repositories must be public to run the benchmark.",
        );
      }
      const mappedPermission = teamRole(
        await client.getPermission(body.fullName, githubLogin, githubToken),
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
        (await client.getCogportalToml(body.fullName, githubToken)) ?? "",
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
    return respond(c, SessionSchema, await authToSession(c.env, await getAuth(c)));
  });

  app.get("/github/installations", async (c) => {
    const auth = await requireUser(c);
    const githubToken = githubConfigured(c.env)
      ? await getGithubToken(authFor(c), auth.user.id, c.req.raw.headers)
      : null;
    if (!githubToken) {
      throw new ApiHttpError(
        403,
        "forbidden",
        "Sign in with GitHub to view installations.",
      );
    }
    const installations = await new RealGitHubClient().listInstallations(githubToken);
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
