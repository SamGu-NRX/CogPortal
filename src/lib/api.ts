/**
 * Typed API client. Every response is parsed against the shared Zod contract
 * so a drifting Worker fails loudly here, not deep inside a component.
 */
import { z } from "zod";
import {
  ApiErrorSchema,
  BenchmarkSchema,
  DashboardSchema,
  GithubRepoSchema,
  LeaderboardSchema,
  RunDetailSchema,
  RunSummarySchema,
  SessionSchema,
  StartRunResponseSchema,
  TeamDetailSchema,
  type ApiErrorCode,
} from "@shared/schema";

export class ApiRequestError extends Error {
  constructor(
    public readonly code: ApiErrorCode | "network" | "unknown",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? "GET",
      credentials: "same-origin",
      headers:
        init?.body !== undefined
          ? { "content-type": "application/json" }
          : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiRequestError(
      "network",
      "Could not reach the portal. Check your connection and try again.",
      0,
    );
  }

  if (!res.ok) {
    let code: ApiErrorCode | "unknown" = "unknown";
    let message = `The portal returned an unexpected error (${res.status}).`;
    try {
      const parsed = ApiErrorSchema.parse(await res.json());
      code = parsed.error.code;
      message = parsed.error.message;
    } catch {
      /* keep fallback */
    }
    throw new ApiRequestError(code, message, res.status);
  }

  return schema.parse(await res.json());
}

export const api = {
  session: () => request("/api/session", SessionSchema),
  devLogin: (body: { login: string }) =>
    request("/api/dev/login", SessionSchema, { method: "POST", body }),
  logout: () =>
    request("/api/session/logout", z.unknown(), { method: "POST" }),

  joinCohort: (slug: string, code: string) =>
    request(`/api/cohorts/${encodeURIComponent(slug)}/join`, SessionSchema, {
      method: "POST",
      body: { code },
    }),

  repositories: () =>
    request("/api/github/repositories", z.array(GithubRepoSchema)),
  connectRepo: (body: { fullName: string; teamName?: string }) =>
    request("/api/github/connect", SessionSchema, {
      method: "POST",
      body,
    }),

  team: () => request("/api/team", TeamDetailSchema),
  renameTeam: (name: string) =>
    request("/api/team", TeamDetailSchema, { method: "PATCH", body: { name } }),

  benchmarks: () => request("/api/benchmarks", z.array(BenchmarkSchema)),
  dashboard: (benchmarkId: string) =>
    request(
      `/api/dashboard?benchmark=${encodeURIComponent(benchmarkId)}`,
      DashboardSchema,
    ),

  runs: (benchmarkId: string) =>
    request(
      `/api/runs?benchmark=${encodeURIComponent(benchmarkId)}`,
      z.array(RunSummarySchema),
    ),
  run: (runId: string) =>
    request(`/api/runs/${encodeURIComponent(runId)}`, RunDetailSchema),
  startPractice: (benchmarkId: string, branch?: string) =>
    request("/api/runs/practice", StartRunResponseSchema, {
      method: "POST",
      body: { benchmarkId, branch },
    }),
  promote: (runId: string) =>
    request(`/api/runs/${encodeURIComponent(runId)}/promote`, StartRunResponseSchema, {
      method: "POST",
    }),

  leaderboard: (benchmarkId?: string) =>
    request(
      benchmarkId
        ? `/api/leaderboard?benchmark=${encodeURIComponent(benchmarkId)}`
        : "/api/leaderboard",
      LeaderboardSchema,
    ),
  selectResult: (runId: string) =>
    request("/api/leaderboard-selection", z.unknown(), {
      method: "PUT",
      body: { runId },
    }),
};
