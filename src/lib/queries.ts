/**
 * TanStack Query bindings. Active runs poll at 2 s (plan §4) and stop the
 * moment they reach a terminal state — no idle polling anywhere else.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ACTIVE_RUN_POLL_MS, isTerminal } from "@shared/schema";
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
    mutationFn: ({ slug, code }: { slug: string; code: string }) =>
      api.joinCohort(slug, code),
    onSuccess: invalidate,
  });
}

export function useConnectRepo() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: api.connectRepo, onSuccess: invalidate });
}

export function useTeam() {
  return useQuery({ queryKey: ["team"], queryFn: api.team });
}

export function useRenameTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.renameTeam,
    onSuccess: (team) => {
      qc.setQueryData(["team"], team);
      void qc.invalidateQueries({ queryKey: ["session"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
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
