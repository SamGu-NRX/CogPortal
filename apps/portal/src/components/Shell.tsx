import { Link, NavLink, Outlet } from "react-router";
import { nextStagePath } from "@/App";
import { UserMenu } from "@/components/UserMenu";
import { useSession } from "@/lib/queries";

export function Wordmark() {
  return (
    <Link
      to="/"
      className="font-serif text-[19px] font-semibold tracking-tight text-ink"
    >
      Cog<span className="text-detect">*</span>Portal
    </Link>
  );
}

function TopNavLink({ to, children }: { to: string; children: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `inline-flex min-h-11 items-center px-1 font-mono text-[11.5px] font-medium tracking-[0.09em] uppercase transition-colors duration-150 ${
          isActive
            ? "text-ink underline decoration-detect decoration-2 underline-offset-8"
            : "text-ink-secondary hover:text-ink"
        }`
      }
    >
      {children}
    </NavLink>
  );
}

export function Shell() {
  const { data: session } = useSession();

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-ink focus:px-3 focus:py-2 focus:text-paper-raised"
      >
        Skip to content
      </a>

      <header className="border-b border-rule bg-paper-raised/85">
        <div className="mx-auto flex min-h-14 w-full max-w-5xl flex-wrap items-center justify-between gap-x-2 px-5 max-[359px]:px-3 sm:gap-x-6">
          <Wordmark />
          <nav
            aria-label="Primary"
            className="flex items-center gap-2 max-[359px]:order-3 max-[359px]:w-full max-[359px]:justify-center max-[359px]:border-t max-[359px]:border-rule-soft sm:gap-7"
          >
            {session?.team && <TopNavLink to="/dashboard">Dashboard</TopNavLink>}
            <TopNavLink to="/leaderboard">Leaderboard</TopNavLink>
          </nav>
          <div className="flex items-center gap-4 max-[359px]:order-2">
            {session?.user ? (
              <UserMenu
                user={session.user}
                hasTeam={Boolean(session.team)}
                isStaff={session.user.platformRole === "staff" || session.user.isTa}
                nextPath={nextStagePath(session)}
              />
            ) : (
              <Link
                to="/signin"
                className="u-pressable inline-flex h-9 items-center bg-ink px-5 text-[13px] font-medium tracking-wide text-paper-raised transition-colors duration-150 hover:bg-ink/90"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-5">
        <Outlet />
      </main>
    </div>
  );
}
