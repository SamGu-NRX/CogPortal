import { Link, NavLink, Outlet, useNavigate } from "react-router";
import { useLogout, useSession } from "@/lib/queries";

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
  const logout = useLogout();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-ink focus:px-3 focus:py-2 focus:text-paper-raised"
      >
        Skip to content
      </a>

      <header className="border-b border-rule bg-paper-raised/85">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-6 px-5">
          <Wordmark />
          <nav aria-label="Primary" className="flex items-center gap-5 sm:gap-7">
            <TopNavLink to="/leaderboard">Leaderboard</TopNavLink>
            {session?.team && <TopNavLink to="/dashboard">Dashboard</TopNavLink>}
          </nav>
          <div className="flex items-center gap-4">
            {session?.user ? (
              <>
                <Link
                  to={session.team ? "/team" : "/dashboard"}
                  className="hidden font-mono text-[12px] text-ink-secondary hover:text-ink sm:inline"
                >
                  {session.user.login}
                </Link>
                <button
                  type="button"
                  onClick={() =>
                    logout.mutate(undefined, { onSuccess: () => navigate("/") })
                  }
                  className="u-pressable inline-flex min-h-11 items-center font-mono text-[11px] tracking-[0.09em] text-ink-secondary uppercase hover:text-ink"
                >
                  Sign out
                </button>
              </>
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
