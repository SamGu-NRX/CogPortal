import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import type { Session } from "@cogworks/contracts/schema";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { Shell } from "@/components/Shell";
import { useRevalidateOnRestore, useSession } from "@/lib/queries";
import { AdminPage } from "@/routes/AdminPage";
import { ConnectPage } from "@/routes/ConnectPage";
import { ConnectionsPage } from "@/routes/ConnectionsPage";
import { DashboardPage } from "@/routes/DashboardPage";
import { GalleryPage } from "@/routes/GalleryPage";
import { JoinPage } from "@/routes/JoinPage";
import { Landing } from "@/routes/Landing";
import { LeaderboardPage } from "@/routes/LeaderboardPage";
import { NotFound } from "@/routes/NotFound";
import { RunDetailPage } from "@/routes/RunDetailPage";
import { RunSurfacePage } from "@/routes/RunSurfacePage";
import { SetupPage } from "@/routes/SetupPage";
import { SignInPage } from "@/routes/SignInPage";
import { TeamPage } from "@/routes/TeamPage";
import { rememberConnectionReturn, rememberDroppedDeviceLink } from "@/lib/pending-return";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

/** Where the student's onboarding actually stands (plan §1 success path):
 *  sign in → join cohort → connect repository → dashboard. */
export function nextStagePath(session: Session): string {
  if (!session.user) return "/signin";
  if (!session.cohort) return "/join";
  if (!session.team) return "/connect";
  return "/dashboard";
}

/** Exported for the render tests; routes reach it through App alone. */
export function RequireStage({
  stage,
  children,
}: {
  stage: "user" | "cohort" | "team";
  children: ReactNode;
}) {
  const { data: session, isPending, isError, error, refetch } = useSession();
  const location = useLocation();
  if (isPending) return <LoadingMark />;
  if (!session) {
    // A failed session read with nothing cached would otherwise be an
    // unresolvable loading mark. A warm tab still has data and falls
    // through to the stage checks below.
    if (isError) return <QueryError error={error} retry={() => void refetch()} />;
    return <LoadingMark />;
  }

  if (!session.user) {
    if (location.pathname === "/connections") {
      rememberConnectionReturn(`${location.pathname}${location.search}${location.hash}`);
    }
    return <Navigate to="/signin" replace />;
  }
  const owed = (stage !== "user" && !session.cohort) || (stage === "team" && !session.team);
  if (owed && location.pathname === "/connections") {
    rememberDroppedDeviceLink(`${location.pathname}${location.search}${location.hash}`);
  }
  if (stage !== "user" && !session.cohort) return <Navigate to="/join" replace />;
  if (stage === "team" && !session.team) return <Navigate to="/connect" replace />;
  return <>{children}</>;
}

/** Staff-only gate — students never see the admin console. */
export function RequireStaff({ children }: { children: ReactNode }) {
  const { data: session, isPending, isError, error, refetch } = useSession();
  if (isError && !session) {
    return <QueryError error={error} retry={() => void refetch()} />;
  }
  if (isPending || !session) return <LoadingMark />;
  if (!session.user) return <Navigate to="/signin" replace />;
  if (session.user.platformRole !== "staff" && !session.user.isTa) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

/** Inside the provider, because it needs the client the routes share. */
function RestoredDocumentGuard({ children }: { children: ReactNode }) {
  useRevalidateOnRestore();
  return <>{children}</>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RestoredDocumentGuard>
        <MotionConfig reducedMotion="user">
        <BrowserRouter>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<Landing />} />
              <Route path="leaderboard" element={<LeaderboardPage />} />
              <Route path="signin" element={<SignInPage />} />
              <Route
                path="join"
                element={
                  <RequireStage stage="user">
                    <JoinPage />
                  </RequireStage>
                }
              />
              <Route
                path="connect"
                element={
                  <RequireStage stage="cohort">
                    <ConnectPage />
                  </RequireStage>
                }
              />
              <Route
                path="connections"
                element={
                  <RequireStage stage="team">
                    <ConnectionsPage />
                  </RequireStage>
                }
              />
              <Route
                path="setup"
                element={
                  <RequireStage stage="team">
                    <SetupPage />
                  </RequireStage>
                }
              />
              <Route
                path="dashboard"
                element={
                  <RequireStage stage="team">
                    <DashboardPage />
                  </RequireStage>
                }
              />
              <Route
                path="team"
                element={
                  <RequireStage stage="team">
                    <TeamPage />
                  </RequireStage>
                }
              />
              <Route
                path="runs/:runId"
                element={
                  <RequireStage stage="team">
                    <RunDetailPage />
                  </RequireStage>
                }
              />
              <Route
                path="run-surfaces/:surfaceId"
                element={
                  <RequireStage stage="team">
                    <RunSurfacePage />
                  </RequireStage>
                }
              />
              <Route
                path="admin"
                element={
                  <RequireStaff>
                    <AdminPage />
                  </RequireStaff>
                }
              />
              {/* Surfaces whose interesting states need a specific run to
                  reach. Stripped from a production bundle by the condition. */}
              {import.meta.env.DEV && (
                <Route path="__gallery" element={<GalleryPage />} />
              )}
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
        </MotionConfig>
      </RestoredDocumentGuard>
    </QueryClientProvider>
  );
}
