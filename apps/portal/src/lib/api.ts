/**
 * Typed API client. Every response is parsed against the shared Zod contract
 * so a drifting Worker fails loudly here, not deep inside a component.
 */
import { z } from "zod";
import {
  AdminOverviewSchema,
  AdminStaffRosterSchema,
  AdminTeamSummarySchema,
  ApiErrorSchema,
  BenchmarkSchema,
  CohortTeamListSchema,
  ConnectionSummarySchema,
  InvitableUserListSchema,
  DashboardSchema,
  DiscordLinkPreviewSchema,
  FamilyLeaderboardSchema,
  GithubInstallationSchema,
  GithubRepoSchema,
  LeaderboardSchema,
  LocalReportListSchema,
  RunDetailSchema,
  RunSurfaceSnapshotSchema,
  RunSummarySchema,
  SessionSchema,
  SetupStateSchema,
  StartRunResponseSchema,
  TeamDetailSchema,
  TeamProcessSignalsSchema,
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
  teamProcess: () => request("/api/v1/team/process", TeamProcessSignalsSchema),
  updateTeam: (body: { name?: string; description?: string | null }) =>
    request("/api/team", TeamDetailSchema, { method: "PATCH", body }),
  changeTeamRepo: (fullName: string) =>
    request("/api/team/repository", TeamDetailSchema, {
      method: "POST",
      body: { fullName },
    }),

  setupState: (benchmarkId?: string) =>
    request(
      benchmarkId
        ? `/api/v1/setup/state?benchmarkId=${encodeURIComponent(benchmarkId)}`
        : "/api/v1/setup/state",
      SetupStateSchema,
    ),
  resetSetupState: () =>
    request("/api/v1/setup/state", z.object({ ok: z.literal(true) }), {
      method: "DELETE",
    }),

  cohortTeams: () => request("/api/cohorts/teams", CohortTeamListSchema),
  joinTeam: (teamId: string) =>
    request("/api/team/join", TeamDetailSchema, {
      method: "POST",
      body: { teamId },
    }),
  invitableUsers: () => request("/api/team/invitable", InvitableUserListSchema),
  addTeamMember: (login: string) =>
    request("/api/team/members", TeamDetailSchema, {
      method: "POST",
      body: { login },
    }),
  removeTeamMember: (login: string) =>
    request(`/api/team/members/${encodeURIComponent(login)}`, TeamDetailSchema, {
      method: "DELETE",
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
  adminAssignTa: (teamId: string, login: string) =>
    request(`/api/admin/teams/${encodeURIComponent(teamId)}/tas`, AdminTeamSummarySchema, {
      method: "POST",
      body: { login },
    }),
  adminRemoveTa: (teamId: string, login: string) =>
    request(
      `/api/admin/teams/${encodeURIComponent(teamId)}/tas/${encodeURIComponent(login)}`,
      AdminTeamSummarySchema,
      { method: "DELETE" },
    ),

  adminStaffRoster: () => request("/api/admin/staff", AdminStaffRosterSchema),
  adminAddStaff: (login: string) =>
    request("/api/admin/staff", AdminStaffRosterSchema, { method: "POST", body: { login } }),
  adminRemoveStaff: (login: string) =>
    request(`/api/admin/staff/${encodeURIComponent(login)}`, AdminStaffRosterSchema, {
      method: "DELETE",
    }),

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
  runSurfaces: () =>
    request("/api/run-surfaces", z.array(RunSurfaceSnapshotSchema)),
  runSurface: (surfaceId: string) =>
    request(`/api/run-surfaces/${encodeURIComponent(surfaceId)}`, RunSurfaceSnapshotSchema),
  mutateRunSurface: (
    surfaceId: string,
    action: "verify_hosted" | "promote_official" | "publish_result" | "rerun_hosted",
  ) =>
    request(
      `/api/run-surfaces/${encodeURIComponent(surfaceId)}/actions/${action}`,
      RunSurfaceSnapshotSchema,
      { method: "POST" },
    ),

  leaderboard: (benchmarkId?: string) =>
    request(
      benchmarkId
        ? `/api/leaderboard?benchmark=${encodeURIComponent(benchmarkId)}`
        : "/api/leaderboard",
      LeaderboardSchema,
    ),
  familyLeaderboard: (familyId: string) =>
    request(
      `/api/leaderboard-family?family=${encodeURIComponent(familyId)}`,
      FamilyLeaderboardSchema,
    ),
  selectResult: (runId: string) =>
    request("/api/leaderboard-selection", z.unknown(), {
      method: "PUT",
      body: { runId },
    }),
};
