import { Link, NavLink, Outlet } from "react-router";
import { nextStagePath } from "@/App";
import { AccountSlot, Concealed } from "@/components/RestoreGate";
import { UserMenu } from "@/components/UserMenu";
import { useSession } from "@/lib/queries";

export function Wordmark() {
  return (
    <Link
      to="/"
      className="shrink-0 font-serif text-[21px] leading-none font-semibold tracking-[-0.02em] text-ink"
    >
      Cog<span className="text-detect">*</span>Portal
    </Link>
  );
}

function Tab({ to, children, end }: { to: string; children: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `relative inline-flex min-h-11 shrink-0 items-center px-3 text-[14.5px] font-semibold transition-colors duration-150 after:absolute after:inset-x-3 after:bottom-0 after:h-[2px] after:rounded-full after:transition-colors after:duration-150 ${
          isActive
            ? "text-ink after:bg-ink"
            : "text-ink-secondary after:bg-transparent hover:text-ink"
        }`
      }
    >
      {children}
    </NavLink>
  );
}

/**
 * The frame every page sits in. A team member's own places are tabs in plain
 * view (their runs, the setup guide, the team), because a student looking for
 * the setup commands should not have to know they live behind an avatar. The
 * account menu keeps what belongs to the person: linked devices, the admin
 * console for staff, and signing out.
 *
 * The team's name sits beside the wordmark as the answer to "whose portal is
 * this": the repository is the team, and everything here belongs to it.
 */
export function Shell() {
  const { data: session } = useSession();
  const team = session?.team ?? null;
  const isStaff = Boolean(session?.user && (session.user.platformRole === "staff" || session.user.isTa));
  // Staff run the console without a team, so "Get started" would send them
  // to create one they don't need.
  const onboarding = Boolean(session?.user && !team && !isStaff);

  const tabs = (
    <>
      {team && (
        <>
          <Tab to="/dashboard">Runs</Tab>
          <Tab to="/setup">Setup</Tab>
          <Tab to="/team">Team</Tab>
        </>
      )}
      {onboarding && session && <Tab to={nextStagePath(session)}>Get started</Tab>}
      <Tab to="/leaderboard">Leaderboard</Tab>
      {isStaff && <Tab to="/admin">Admin</Tab>}
    </>
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-ink focus:px-3 focus:py-2 focus:text-paper-raised"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-rule bg-paper/88 backdrop-blur-[6px] supports-[not(backdrop-filter:blur(1px))]:bg-paper">
        <div className="mx-auto flex min-h-16 w-full max-w-[70rem] flex-wrap items-center gap-x-6 px-5 max-[359px]:px-3">
          <div className="flex min-w-0 flex-1 items-center gap-3 md:flex-none">
            <Wordmark />
            {team && (
              <Concealed className="hidden min-w-0 items-center gap-3 lg:flex">
                <span aria-hidden="true" className="h-5 w-px bg-rule-strong" />
                <Link
                  to="/team"
                  className="truncate text-[14.5px] font-semibold text-ink-secondary transition-colors duration-150 hover:text-ink"
                  title={team.name}
                >
                  {team.name}
                </Link>
              </Concealed>
            )}
          </div>

          <nav
            aria-label="Primary"
            className="hidden flex-1 items-center gap-1 md:flex"
          >
            {tabs}
          </nav>

          {/* The account's name is withheld with the page it belongs to. */}
          <AccountSlot>
            {session?.user ? (
              <UserMenu
                user={session.user}
                hasTeam={Boolean(team)}
                nextPath={nextStagePath(session)}
                teamName={team?.name ?? null}
              />
            ) : (
              <Link
                to="/signin"
                className="u-pressable inline-flex min-h-10 items-center rounded-control bg-ink px-4 text-[14px] font-semibold text-paper-raised transition-colors duration-150 hover:bg-ink/85"
              >
                Sign in
              </Link>
            )}
          </AccountSlot>
        </div>

        {/* Below md the tabs take their own row and scroll sideways rather
            than wrap, so the header keeps one height on every page. */}
        <nav
          aria-label="Primary"
          className="flex overflow-x-auto border-t border-rule-soft px-2 [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden"
        >
          {tabs}
        </nav>
      </header>

      <main id="main" className="mx-auto flex w-full max-w-[70rem] flex-1 flex-col px-5 max-[359px]:px-3">
        <Outlet />
      </main>

      <footer className="mx-auto w-full max-w-[70rem] px-5 pt-10 pb-8 max-[359px]:px-3">
        <p className="border-t border-rule-soft pt-4 text-[13px] text-ink-faint">
          Cog*Portal runs the CogWorks capstone benchmarks for MIT Beaver Works Summer Institute.
        </p>
      </footer>
    </div>
  );
}
