import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ACTIVE_RUN_POLL_MS,
  isBenchmarkScopedStep,
  isTerminal,
  type AdminOverview,
  type AdminStaffRoster,
} from "@cogworks/contracts/schema";
import { api } from "./api";
import { CHECKLIST_MACHINE_STEPS } from "./setup-progress";

/** Only used before the benchmark list resolves, as a first-render probe.
 *  Which track a team is actually looking at is `useTrack()` in lib/track.ts;
 *  do not reach for this constant to scope a run, a quota, or setup copy. */
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

export function useRunSurface(surfaceId: string) {
  return useQuery({
    queryKey: ["run-surface", surfaceId],
    queryFn: () => api.runSurface(surfaceId),
  });
}

export function useMutateRunSurface() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      surfaceId,
      action,
    }: {
      surfaceId: string;
      action: "verify_hosted" | "promote_official" | "publish_result" | "rerun_hosted";
    }) => api.mutateRunSurface(surfaceId, action),
    onSuccess: (snapshot) => {
      qc.setQueryData(["run-surface", snapshot.id], snapshot);
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      void qc.invalidateQueries({ queryKey: ["runs"] });
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

export function useFamilyLeaderboard(familyId: string) {
  return useQuery({
    queryKey: ["leaderboard-family", familyId],
    queryFn: () => api.familyLeaderboard(familyId),
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
    refetchInterval: (query) =>
      query.state.data && query.state.data.cliDevices.length > 0 ? false : 4_000,
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
  return useMutation({
    mutationFn: ({ userCode, deviceName }: { userCode: string; deviceName: string }) =>
      api.approveDevice(userCode, deviceName),
  });
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

/** Invalidate everything the session gates. Returns the refetch promise so
 *  mutation onSuccess can await it — navigation after joining/creating a team
 *  must not race the stale session through a route guard. */
function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
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

/** The four process signals. The worker recomputes these at most every 30
 *  minutes and serves a cached row in between, so refetching on focus would
 *  spend a request to get the same bytes back. */
export function useTeamProcess() {
  return useQuery({
    queryKey: ["team-process"],
    queryFn: api.teamProcess,
    staleTime: 5 * 60_000,
  });
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
      // The signals describe a repository's history, so they belong to the
      // repository rather than to the team. Leaving them cached showed the
      // previous repository's stages under the new repository's name.
      void qc.invalidateQueries({ queryKey: ["team-process"] });
    },
  });
}

/**
 * TanStack Query pauses this polling when the page is unmounted or backgrounded.
 *
 * `benchmarkId` is the selected track, and it is what the stop condition is
 * about. Two of the four checklist steps are recorded per benchmark, so the
 * raw `verified` array is the wrong thing to wait on in both directions: an
 * older CLI's unscoped rows would stop the poll while the selected track is
 * still incomplete, and a current CLI's scoped rows would never stop it at
 * all. Undefined while the track loads, which keeps polling.
 */
export function useSetupState(benchmarkId?: string) {
  return useQuery({
    queryKey: ["setup-state"],
    queryFn: api.setupState,
    staleTime: 3_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 2_500;
      // The visible checklist's own completion set. SETUP_STEPS also carries
      // test/run milestones the checklist never shows, so waiting on every
      // step kept a finished page polling forever.
      const scoped = (benchmarkId && data.verifiedByBenchmark[benchmarkId]) || [];
      const complete = CHECKLIST_MACHINE_STEPS.every((step) =>
        isBenchmarkScopedStep(step) ? scoped.includes(step) : data.verified.includes(step),
      );
      return complete ? false : 2_500;
    },
  });
}

export function useResetSetupState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.resetSetupState,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["setup-state"] }),
  });
}

/* ── Joining a team & member management ───────────────────────────────── */

export function useCohortTeams(enabled = true) {
  return useQuery({
    queryKey: ["cohort-teams"],
    queryFn: api.cohortTeams,
    enabled,
    staleTime: 30_000,
  });
}

export function useJoinTeam() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: api.joinTeam, onSuccess: invalidate });
}

export function useInvitableUsers(enabled = true) {
  return useQuery({
    queryKey: ["invitable"],
    queryFn: api.invitableUsers,
    enabled,
    staleTime: 30_000,
  });
}

export function useAddTeamMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.addTeamMember,
    onSuccess: (team) => {
      qc.setQueryData(["team"], team);
      void qc.invalidateQueries({ queryKey: ["invitable"] });
      void qc.invalidateQueries({ queryKey: ["cohort-teams"] });
      void qc.invalidateQueries({ queryKey: ["admin"] });
    },
  });
}

export function useRemoveTeamMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.removeTeamMember,
    onSuccess: (team) => {
      qc.setQueryData(["team"], team);
      void qc.invalidateQueries({ queryKey: ["invitable"] });
      void qc.invalidateQueries({ queryKey: ["cohort-teams"] });
      void qc.invalidateQueries({ queryKey: ["admin"] });
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.adminPatchCohort,
    onSuccess: (cohort) => {
      // The PATCH response is authoritative. Replace the visible cohort
      // immediately instead of briefly showing the old credential while a
      // follow-up request is in flight.
      qc.setQueryData<AdminOverview>(["admin", "overview"], (overview) =>
        overview ? { ...overview, cohort } : overview,
      );
      void qc.invalidateQueries({ queryKey: ["leaderboard"] });
    },
  });
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

/* The roster is owner-only on the server, so a TA's request would 403. The
 * query is disabled for them rather than left to fail, so the console does not
 * show an error for a panel it is not going to render. */
export function useAdminStaffRoster(enabled = true) {
  return useQuery({
    queryKey: ["admin", "staff"],
    queryFn: api.adminStaffRoster,
    enabled,
  });
}

function useSetStaffRoster() {
  const qc = useQueryClient();
  // Both mutations return the whole roster, so the response is authoritative
  // and replaces the cache directly. Same reason useAdminPatchCohort does.
  return (roster: AdminStaffRoster) => qc.setQueryData(["admin", "staff"], roster);
}

export function useAdminAddStaff() {
  const setRoster = useSetStaffRoster();
  return useMutation({ mutationFn: api.adminAddStaff, onSuccess: setRoster });
}

export function useAdminRemoveStaff() {
  const setRoster = useSetStaffRoster();
  return useMutation({ mutationFn: api.adminRemoveStaff, onSuccess: setRoster });
}

export function useStartPractice(benchmarkId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (branch?: string) => api.startPractice(benchmarkId, branch),
    // Returning this promise keeps the launch pending until the stale
    // zero-run dashboard has been replaced by the refetched state.
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["dashboard", benchmarkId] }),
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
