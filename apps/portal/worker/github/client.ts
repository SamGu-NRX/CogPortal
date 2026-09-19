import { FIXTURE_REPO, FIXTURE_SCENARIOS } from "@cogworks/contracts/fixtures";
import type { GithubRepo } from "@cogworks/contracts/schema";

const GITHUB_API = "https://api.github.com";
const GITHUB_ACCEPT = "application/vnd.github+json";

export type GitHubRepositoryListing = Omit<GithubRepo, "claimedByTeam">;

export class GitHubApiError extends Error {
  constructor(public readonly status: number) {
    super(`GitHub API request failed with status ${status}.`);
    this.name = "GitHubApiError";
  }
}

export function isGitHubUnauthorized(error: unknown): boolean {
  return error instanceof GitHubApiError && error.status === 401;
}

export interface GitHubClient {
  resolveRef(owner: string, name: string, ref: string, token: string): Promise<string>;
  listRepositories(token: string): Promise<GitHubRepositoryListing[]>;
}

export interface GitHubRepository {
  id: number;
  private: boolean;
  description: string | null;
  fork: boolean;
  pushedAt: number | null;
  url: string;
  defaultBranch: string;
  owner: { login: string; type: string };
  name: string;
  parentFullName: string | null;
  sourceRepositoryId: number | null;
}

export interface GitHubInstallation {
  id: number;
  account: string;
  accountType: string;
  avatarUrl: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`GitHub response is missing ${key}.`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`GitHub response is missing ${key}.`);
  return value;
}

function parseRepository(value: unknown): GitHubRepository {
  if (
    !isRecord(value) ||
    !isRecord(value.owner) ||
    typeof value.private !== "boolean" ||
    typeof value.fork !== "boolean" ||
    (value.description !== null && typeof value.description !== "string") ||
    (value.pushed_at !== null && typeof value.pushed_at !== "string")
  ) {
    throw new Error("GitHub returned an invalid repository.");
  }
  return {
    id: requiredNumber(value, "id"),
    private: value.private,
    description: value.description,
    fork: value.fork,
    pushedAt: value.pushed_at === null ? null : Date.parse(value.pushed_at),
    url: requiredString(value, "html_url"),
    defaultBranch: requiredString(value, "default_branch"),
    owner: {
      login: requiredString(value.owner, "login"),
      type: requiredString(value.owner, "type"),
    },
    name: requiredString(value, "name"),
    parentFullName:
      isRecord(value.parent) && typeof value.parent.full_name === "string"
        ? value.parent.full_name
        : null,
    sourceRepositoryId:
      isRecord(value.source) && typeof value.source.id === "number"
        ? value.source.id
        : isRecord(value.parent) && typeof value.parent.id === "number"
          ? value.parent.id
          : null,
  };
}

function compareRepositoriesByRecency(
  left: GitHubRepository,
  right: GitHubRepository,
): number {
  const leftPushedAt = left.pushedAt ?? Number.NEGATIVE_INFINITY;
  const rightPushedAt = right.pushedAt ?? Number.NEGATIVE_INFINITY;
  if (leftPushedAt !== rightPushedAt) return rightPushedAt - leftPushedAt;
  return `${left.owner.login}/${left.name}`.localeCompare(
    `${right.owner.login}/${right.name}`,
  );
}

function repoParts(fullName: string): [string, string] {
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Repository name must be in owner/name form.");
  }
  return [parts[0], parts[1]];
}

export async function githubApiRequest(
  path: string,
  token: string,
  accept = GITHUB_ACCEPT,
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "User-Agent": "cogportal",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
}

async function githubJson(path: string, token: string): Promise<unknown> {
  const response = await githubApiRequest(path, token);
  if (!response.ok) throw new GitHubApiError(response.status);
  return response.json();
}

export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function xorshift32(value: number): number {
  let next = value || 0x9e3779b9;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

export class FixtureGitHubClient implements GitHubClient {
  async resolveRef(owner: string, name: string, branch: string): Promise<string> {
    let state = fnv1a32(`${owner}/${name}#${branch}`);
    const pieces: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      state = xorshift32(state);
      pieces.push(state.toString(16).padStart(8, "0"));
    }
    return pieces.join("");
  }

  async listRepositories(): Promise<GitHubRepositoryListing[]> {
    return [
      {
        ...FIXTURE_REPO,
        branches: FIXTURE_SCENARIOS.map((scenario) => scenario.branch),
        description: FIXTURE_REPO.description,
        isFork: false,
        pushedAt: null,
      },
    ];
  }
}

export class RealGitHubClient implements GitHubClient {
  async listInstallations(token: string): Promise<GitHubInstallation[]> {
    const payload = await githubJson("/user/installations", token);
    if (!isRecord(payload) || !Array.isArray(payload.installations)) {
      throw new Error("GitHub returned an invalid installation list.");
    }
    return payload.installations.map((value) => {
      if (!isRecord(value) || !isRecord(value.account)) {
        throw new Error("GitHub returned an invalid installation.");
      }
      const avatarUrl = value.account.avatar_url;
      if (avatarUrl !== null && typeof avatarUrl !== "string") {
        throw new Error("GitHub returned an invalid installation account.");
      }
      return {
        id: requiredNumber(value, "id"),
        account: requiredString(value.account, "login"),
        accountType: requiredString(value.account, "type"),
        avatarUrl,
      };
    });
  }

  async listRepositories(token: string): Promise<GitHubRepositoryListing[]> {
    const installations = await this.listInstallations(token);
    const repositoryLists = await Promise.all(
      installations.map(async (installation) => {
        // A failed installation lookup must reach the route's error response, not hide repositories.
        const payload = await githubJson(
          `/user/installations/${installation.id}/repositories?per_page=100`,
          token,
        );
        if (!isRecord(payload) || !Array.isArray(payload.repositories)) {
          throw new Error("GitHub returned an invalid repository list.");
        }
        return payload.repositories.map(parseRepository);
      }),
    );
    const repositories = repositoryLists
      .flat()
      .filter((repo) => !repo.private)
      .sort(compareRepositoriesByRecency)
      .slice(0, 50);
    return Promise.all(
      repositories.map(async (repo) => {
        const fullName = `${repo.owner.login}/${repo.name}`;
        let branchNames: string[] = [];
        try {
          const payload = await githubJson(
            `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/branches?per_page=30`,
            token,
          );
          if (!Array.isArray(payload)) throw new Error("GitHub returned an invalid branch list.");
          branchNames = payload.map((value) => {
            if (!isRecord(value)) throw new Error("GitHub returned an invalid branch.");
            return requiredString(value, "name");
          });
        } catch {
          // The repository is still known even when its optional branch listing fails.
          console.warn(
            JSON.stringify({ evt: "github_api_failure", operation: "list_branches", repo: fullName }),
          );
        }
        return {
          repositoryId: repo.id,
          owner: repo.owner.login,
          name: repo.name,
          fullName,
          url: repo.url,
          defaultBranch: repo.defaultBranch,
          description: repo.description,
          isFork: repo.fork,
          pushedAt: repo.pushedAt,
          branches: [
            repo.defaultBranch,
            ...branchNames.filter((name) => name !== repo.defaultBranch),
          ].slice(0, 30),
        };
      }),
    );
  }

  async resolveRef(owner: string, name: string, ref: string, token: string): Promise<string> {
    const payload = await githubJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(ref)}`,
      token,
    );
    if (!isRecord(payload)) throw new Error("GitHub returned an invalid commit.");
    const sha = requiredString(payload, "sha");
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("GitHub did not return a full commit SHA.");
    return sha;
  }

  async getRepo(fullName: string, token: string): Promise<GitHubRepository> {
    const [owner, name] = repoParts(fullName);
    return parseRepository(
      await githubJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        token,
      ),
    );
  }

  async getPermission(fullName: string, username: string, token: string): Promise<string> {
    const [owner, name] = repoParts(fullName);
    const payload = await githubJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators/${encodeURIComponent(username)}/permission`,
      token,
    );
    if (!isRecord(payload)) throw new Error("GitHub returned an invalid permission.");
    const roleName = payload.role_name;
    if (typeof roleName === "string") return roleName;
    return requiredString(payload, "permission");
  }

  async getCogportalToml(fullName: string, token: string): Promise<string | null> {
    const [owner, name] = repoParts(fullName);
    const response = await githubApiRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/cogportal.toml`,
      token,
      "application/vnd.github.raw+json",
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new GitHubApiError(response.status);
    return response.text();
  }
}
