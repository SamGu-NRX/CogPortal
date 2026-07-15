import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import type { Session } from "@cogworks/contracts/schema";
import { LoadingMark } from "@/components/Feedback";
import { Shell } from "@/components/Shell";
import { useSession } from "@/lib/queries";
import { AdminPage } from "@/routes/AdminPage";
import { ConnectPage } from "@/routes/ConnectPage";
import { ConnectionsPage } from "@/routes/ConnectionsPage";
import { DashboardPage } from "@/routes/DashboardPage";
import { JoinPage } from "@/routes/JoinPage";
import { Landing } from "@/routes/Landing";
import { LeaderboardPage } from "@/routes/LeaderboardPage";
import { NotFound } from "@/routes/NotFound";
import { RunDetailPage } from "@/routes/RunDetailPage";
import { RunSurfacePage } from "@/routes/RunSurfacePage";
import { SetupPage } from "@/routes/SetupPage";
import { SignInPage } from "@/routes/SignInPage";
import { TeamPage } from "@/routes/TeamPage";
import { rememberConnectionReturn } from "@/lib/pending-return";

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

function RequireStage({
  stage,
  children,
}: {
  stage: "user" | "cohort" | "team";
  children: ReactNode;
}) {
  const { data: session, isPending } = useSession();
  const location = useLocation();
  if (isPending) return <LoadingMark />;
  if (!session) return <LoadingMark />;

  if (!session.user) {
    if (location.pathname === "/connections") {
      rememberConnectionReturn(`${location.pathname}${location.search}${location.hash}`);
    }
    return <Navigate to="/signin" replace />;
  }
  if (stage !== "user" && !session.cohort) return <Navigate to="/join" replace />;
  if (stage === "team" && !session.team) return <Navigate to="/connect" replace />;
  return <>{children}</>;
}

/** Staff-only gate — students never see the admin console. */
function RequireStaff({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  if (isPending || !session) return <LoadingMark />;
  if (!session.user) return <Navigate to="/signin" replace />;
  if (session.user.platformRole !== "staff" && !session.user.isTa) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
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
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </MotionConfig>
    </QueryClientProvider>
  );
}
