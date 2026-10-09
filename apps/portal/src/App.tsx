import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { LoadingMark } from "@/components/Feedback";
import { Shell } from "@/components/Shell";
import { useSession } from "@/lib/queries";
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
import { rememberConnectionReturn } from "@/lib/pending-return";
import {
  staffGuardDecision,
  stageGuardDecision,
  type StageRequirement,
} from "@/lib/stage-routing";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

// Landing and SignInPage still import this from "@/App"; the decision lives
// in lib/stage-routing.ts next to the route guards.
export { nextStagePath } from "@/lib/stage-routing";

function RequireStage({
  stage,
  children,
}: {
  stage: StageRequirement;
  children: ReactNode;
}) {
  const { data: session, isPending } = useSession();
  const location = useLocation();
  if (isPending || !session) return <LoadingMark />;

  const decision = stageGuardDecision(
    stage,
    `${location.pathname}${location.search}${location.hash}`,
    session,
  );
  if (decision.action === "remember-and-redirect") {
    rememberConnectionReturn(decision.returnTo);
  }
  if (decision.action === "render") return <>{children}</>;
  return <Navigate to={decision.to} replace />;
}

/** Staff-only gate — students never see the admin console. */
function RequireStaff({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  if (isPending || !session) return <LoadingMark />;

  const decision = staffGuardDecision(session);
  if (decision.action === "render") return <>{children}</>;
  return <Navigate to={decision.to} replace />;
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
    </QueryClientProvider>
  );
}
