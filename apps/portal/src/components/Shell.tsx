import { useLayoutEffect, useRef } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigationType } from "react-router";
import { nextStagePath } from "@/App";
import { AccountSlot, Concealed } from "@/components/RestoreGate";
import { UserMenu } from "@/components/UserMenu";
import { useSession } from "@/lib/queries";
import { canOpenAdmin } from "@/lib/roles";

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

function Tab({ to, children, also = [] }: { to: string; children: string; also?: string[] }) {
  const { pathname } = useLocation();
  // A run's own page belongs to Runs, so the tab stays lit while reading one.
  const within = also.some((prefix) => pathname.startsWith(prefix));
  return (
    <NavLink
      to={to}
      className={({ isActive: exact }) => {
        const isActive = exact || within;
        return `relative inline-flex min-h-11 shrink-0 items-center px-3 text-[14.5px] font-semibold transition-colors duration-150 after:absolute after:inset-x-3 after:bottom-0 after:h-[2px] after:rounded-full after:transition-colors after:duration-150 ${
          isActive
            ? "text-ink after:bg-ink"
            : "text-ink-secondary after:bg-transparent hover:text-ink"
        }`;
      }}
    >
      {children}
    </NavLink>
  );
}

/** BrowserRouter keeps the previous page's offset, so without this a link
 *  near the foot of one page opens the next at its foot. Back and Forward
 *  keep the browser's restored offset, and a same-page URL change (a wizard
 *  step, a consumed query param) stays put. This renders ahead of the page,
 *  so a page that scrolls to its own target, as Setup does for `#step-…`,
 *  still wins. */
export function ScrollToTopOnNavigate() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  useLayoutEffect(() => {
    if (navigationType !== "POP") window.scrollTo(0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new pathname is a new page
  }, [pathname]);
  return null;
}

/** Publishes the sticky header's real height (two rows below md, more when a
 *  long login wraps it) for `scroll-padding-top`, so a control focused near
 *  the top scrolls clear of the header instead of under it. */
function useHeaderOffset() {
  const header = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = header.current;
    if (!element) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty("--shell-header-height", `${element.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element, { box: "border-box" });
    return () => {
      observer.disconnect();
      root.style.removeProperty("--shell-header-height");
    };
  }, []);
  return header;
}

/**
 * The frame every page sits in. A team member's own places are tabs in plain
 * view (their runs, the setup guide, the team), because a student looking for
 * the setup commands should not have to know they live behind an avatar. The
 * account menu keeps what belongs to the person: linked devices and signing
 * out.
 *
 * The team's name sits beside the wordmark as the answer to "whose portal is
 * this": the repository is the team, and everything here belongs to it.
 */
export function Shell() {
  const { data: session } = useSession();
  const team = session?.team ?? null;
  const isStaff = Boolean(session?.user && canOpenAdmin(session.user));
  // Staff run the console without a team, so "Get started" would send them
  // to create one they don't need.
  const onboarding = Boolean(session?.user && !team && !isStaff);
  const header = useHeaderOffset();

  const tabs = (
    <>
      {team && (
        <>
          <Tab to="/dashboard" also={["/runs/", "/run-surfaces/"]}>Runs</Tab>
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
      <ScrollToTopOnNavigate />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-ink focus:px-3 focus:py-2 focus:text-paper-raised"
      >
        Skip to content
      </a>

      <header ref={header} className="sticky top-0 z-40 border-b border-rule pt-[env(safe-area-inset-top)] bg-paper/88 backdrop-blur-[6px] supports-[not(backdrop-filter:blur(1px))]:bg-paper">
        <div className="u-gutter mx-auto flex min-h-16 w-full max-w-[70rem] flex-wrap items-center gap-x-6">
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
                className="u-pressable inline-flex min-h-11 items-center rounded-control bg-ink px-4 text-[14px] font-semibold text-paper-raised transition-colors duration-150 hover:bg-ink/85"
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
          className="flex overflow-x-auto border-t border-rule-soft pr-[env(safe-area-inset-right)] pl-[max(0.5rem,env(safe-area-inset-left))] [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden"
        >
          {tabs}
        </nav>
      </header>

      <main id="main" className="u-gutter mx-auto flex w-full max-w-[70rem] flex-1 flex-col">
        <Outlet />
      </main>

      <footer className="u-gutter mx-auto w-full max-w-[70rem] pt-10 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <p className="border-t border-rule-soft pt-4 text-[13px] text-ink-faint">
          Cog*Portal runs the CogWorks capstone benchmarks for MIT Beaver Works Summer Institute.
        </p>
      </footer>
    </div>
  );
}
