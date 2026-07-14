/**
 * Typed API client. Every response is parsed against the shared Zod contract
 * so a drifting Worker fails loudly here, not deep inside a component.
 */
import { z } from "zod";
import {
  AdminOverviewSchema,
  AdminTeamSummarySchema,
  ApiErrorSchema,
  BenchmarkSchema,
  ConnectionSummarySchema,
  DashboardSchema,
  DiscordLinkPreviewSchema,
  GithubInstallationSchema,
  GithubRepoSchema,
  LeaderboardSchema,
  LocalReportListSchema,
  RunDetailSchema,
  RunSummarySchema,
  SessionSchema,
  StartRunResponseSchema,
  TeamDetailSchema,
  type ApiErrorCode,
} from "@cogworks/contracts/schema";

const AdminCohortSchema = AdminOverviewSchema.shape.cohort;

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
  devLogin: (body: { login: string; demo?: boolean }) =>
    request("/api/dev/login", SessionSchema, { method: "POST", body }),
  logout: () =>
    request("/api/session/logout", z.unknown(), { method: "POST" }),

  joinCohort: (code: string) =>
    request("/api/cohorts/join", SessionSchema, {
      method: "POST",
      body: { code },
    }),

  repositories: () =>
    request("/api/github/repositories", z.array(GithubRepoSchema)),
  installations: () =>
    request("/api/github/installations", z.array(GithubInstallationSchema)),
  connectRepo: (body: { fullName: string; teamName?: string }) =>
    request("/api/github/connect", SessionSchema, {
      method: "POST",
      body,
    }),

  connections: () => request("/api/v1/connections", ConnectionSummarySchema),
  previewDiscordLink: (token: string) =>
    request("/api/v1/connections/discord/preview", DiscordLinkPreviewSchema, {
      method: "POST",
      body: { token },
    }),
  confirmDiscordLink: (token: string) =>
    request("/api/v1/connections/discord/confirm", ConnectionSummarySchema, {
      method: "POST",
      body: { token },
    }),
  unlinkDiscord: () =>
    request("/api/v1/connections/discord", ConnectionSummarySchema, {
      method: "DELETE",
    }),
  approveDevice: (userCode: string, deviceName: string) =>
    request("/api/v1/cli/device/approve", z.object({ ok: z.boolean() }), {
      method: "POST",
      body: { userCode, deviceName },
    }),
  revokeDevice: (deviceId: string) =>
    request("/api/v1/cli/devices", ConnectionSummarySchema, {
      method: "DELETE",
      body: { deviceId },
    }),

  team: () => request("/api/team", TeamDetailSchema),
  updateTeam: (body: { name?: string; description?: string | null }) =>
    request("/api/team", TeamDetailSchema, { method: "PATCH", body }),
  changeTeamRepo: (fullName: string) =>
    request("/api/team/repository", TeamDetailSchema, {
      method: "POST",
      body: { fullName },
    }),

  adminOverview: () => request("/api/admin/overview", AdminOverviewSchema),
  adminPatchCohort: (body: { rotateJoinCode?: boolean; active?: boolean }) =>
    request("/api/admin/cohort", AdminCohortSchema, { method: "PATCH", body }),
  adminPatchTeam: (
    teamId: string,
    body: { name?: string; description?: string | null },
  ) =>
    request(`/api/admin/teams/${encodeURIComponent(teamId)}`, AdminTeamSummarySchema, {
      method: "PATCH",
      body,
    }),
  adminAddMember: (teamId: string, login: string) =>
    request(`/api/admin/teams/${encodeURIComponent(teamId)}/members`, AdminTeamSummarySchema, {
      method: "POST",
      body: { login },
    }),
  adminRemoveMember: (teamId: string, login: string) =>
    request(
      `/api/admin/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(login)}`,
      AdminTeamSummarySchema,
      { method: "DELETE" },
    ),

  benchmarks: () => request("/api/benchmarks", z.array(BenchmarkSchema)),
  localReports: (benchmarkId: string) =>
    request(
      `/api/v1/local-reports?benchmark=${encodeURIComponent(benchmarkId)}`,
      LocalReportListSchema,
    ),
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
