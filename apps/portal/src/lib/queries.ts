/**
 * TanStack Query bindings. Active runs poll at 2 s (plan §4) and stop the
 * moment they reach a terminal state — no idle polling anywhere else.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ACTIVE_RUN_POLL_MS, isTerminal } from "@cogworks/contracts/schema";
import { api } from "./api";

export const DEFAULT_BENCHMARK = "vision-recognition";

export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: api.session,
    staleTime: 60_000,
  });
}

export function useBenchmarks() {
  return useQuery({
    queryKey: ["benchmarks"],
    queryFn: api.benchmarks,
    staleTime: 5 * 60_000,
  });
}

export function useDashboard(benchmarkId: string, enabled = true) {
  return useQuery({
    queryKey: ["dashboard", benchmarkId],
    queryFn: () => api.dashboard(benchmarkId),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.activeRun ? ACTIVE_RUN_POLL_MS : false,
  });
}

export function useLocalReports(benchmarkId: string) {
  return useQuery({
    queryKey: ["local-reports", benchmarkId],
    queryFn: () => api.localReports(benchmarkId),
    staleTime: 30_000,
  });
}

export function useRun(runId: string) {
  return useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && !isTerminal(status) ? ACTIVE_RUN_POLL_MS : false;
    },
  });
}

export function useLeaderboard(benchmarkId?: string) {
  return useQuery({
    queryKey: ["leaderboard", benchmarkId ?? "active"],
    queryFn: () => api.leaderboard(benchmarkId),
    staleTime: 30_000,
  });
}

export function useRepositories(enabled = true) {
  return useQuery({
    queryKey: ["repositories"],
    queryFn: api.repositories,
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useConnections() {
  return useQuery({
    queryKey: ["connections"],
    queryFn: api.connections,
    staleTime: 30_000,
  });
}

export function useDiscordLinkPreview(token: string | null) {
  return useQuery({
    queryKey: ["discord-link-preview", token],
    queryFn: () => api.previewDiscordLink(token!),
    enabled: Boolean(token),
    retry: false,
  });
}

export function useConfirmDiscordLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.confirmDiscordLink,
    onSuccess: (connections) => {
      qc.setQueryData(["connections"], connections);
    },
  });
}

export function useUnlinkDiscord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.unlinkDiscord,
    onSuccess: (connections) => {
      qc.setQueryData(["connections"], connections);
    },
  });
}

export function useApproveDevice() {
  return useMutation({ mutationFn: ({ userCode, deviceName }: { userCode: string; deviceName: string }) => api.approveDevice(userCode, deviceName) });
}

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.revokeDevice,
    onSuccess: (connections) => {
      qc.setQueryData(["connections"], connections);
    },
  });
}

/** Invalidate everything the session gates. */
function useInvalidateAll() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries();
  };
}

export function useDevLogin() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: api.devLogin, onSuccess: invalidate });
}

export function useLogout() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: api.logout, onSuccess: invalidate });
}

export function useJoinCohort() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (code: string) => api.joinCohort(code),
    onSuccess: invalidate,
  });
}

export function useInstallations(enabled = true) {
  return useQuery({
    queryKey: ["installations"],
    queryFn: api.installations,
    enabled,
    staleTime: 5 * 60_000,
    retry: false, // 403 for dev-auth users — treat as "not available", no retry storm
  });
}

export function useConnectRepo() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: api.connectRepo, onSuccess: invalidate });
}

export function useTeam() {
  return useQuery({ queryKey: ["team"], queryFn: api.team });
}

export function useUpdateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.updateTeam,
    onSuccess: (team) => {
      qc.setQueryData(["team"], team);
      void qc.invalidateQueries({ queryKey: ["session"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useChangeTeamRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.changeTeamRepo,
    onSuccess: (team) => {
      qc.setQueryData(["team"], team);
      void qc.invalidateQueries({ queryKey: ["session"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      void qc.invalidateQueries({ queryKey: ["repositories"] });
      void qc.invalidateQueries({ queryKey: ["leaderboard"] });
    },
  });
}

/* ── Admin console (staff) ────────────────────────────────────────────── */

export function useAdminOverview(enabled = true) {
  return useQuery({
    queryKey: ["admin", "overview"],
    queryFn: api.adminOverview,
    enabled,
  });
}

function useAdminInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["admin"] });
    void qc.invalidateQueries({ queryKey: ["leaderboard"] });
  };
}

export function useAdminPatchCohort() {
  const invalidate = useAdminInvalidate();
  return useMutation({ mutationFn: api.adminPatchCohort, onSuccess: invalidate });
}

export function useAdminPatchTeam() {
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: ({ teamId, ...body }: { teamId: string; name?: string; description?: string | null }) =>
      api.adminPatchTeam(teamId, body),
    onSuccess: invalidate,
  });
}

export function useAdminAddMember() {
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: ({ teamId, login }: { teamId: string; login: string }) =>
      api.adminAddMember(teamId, login),
    onSuccess: invalidate,
  });
}

export function useAdminRemoveMember() {
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: ({ teamId, login }: { teamId: string; login: string }) =>
      api.adminRemoveMember(teamId, login),
    onSuccess: invalidate,
  });
}

export function useAdminAssignTa() {
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: ({ teamId, login }: { teamId: string; login: string }) =>
      api.adminAssignTa(teamId, login),
    onSuccess: invalidate,
  });
}

export function useAdminRemoveTa() {
  const invalidate = useAdminInvalidate();
  return useMutation({
    mutationFn: ({ teamId, login }: { teamId: string; login: string }) =>
      api.adminRemoveTa(teamId, login),
    onSuccess: invalidate,
  });
}

export function useStartPractice(benchmarkId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (branch?: string) => api.startPractice(benchmarkId, branch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dashboard", benchmarkId] });
    },
  });
}

export function usePromote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.promote(runId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      void qc.invalidateQueries({ queryKey: ["run"] });
    },
  });
}

export function useSelectResult() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.selectResult(runId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      void qc.invalidateQueries({ queryKey: ["run"] });
      void qc.invalidateQueries({ queryKey: ["leaderboard"] });
    },
  });
}
