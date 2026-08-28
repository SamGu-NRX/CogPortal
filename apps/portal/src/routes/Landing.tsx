import { Link, Navigate } from "react-router";
import { GitHubIcon } from "@/components/GitHubIcon";
import { nextStagePath } from "@/App";
import { useSession } from "@/lib/queries";
import { pendingConnectionReturn } from "@/lib/pending-return";

/**
 * The landing page is the setup guide. Students arrive knowing why they're
 * here — the page's job is to get a fork running against the benchmark with
 * zero detours.
 */
export function Landing() {
  const { data: session } = useSession();
  // This page used to carry the setup commands. It cannot: the sequence needs
  // a clone step and the CLI's own install, and a signed-out page has no track
  // to name them against, so a student who followed it literally reached
  // "cogworks: command not found". The commands live on /setup, which knows
  // the track and can verify each step. This page sells the shape of the work.
  const authed = Boolean(session?.user);
  const template = session?.auth.templateRepo ?? null;
  const pendingReturn = session?.user ? pendingConnectionReturn() : null;
  if (pendingReturn) return <Navigate to={pendingReturn} replace />;

  return (
    <div className="anim-rise mx-auto w-full max-w-2xl py-14">
      <h1 className="mt-3 text-4xl">
        The Cog<span className="text-detect">*</span>Works benchmark.
      </h1>
      <p className="mt-3 text-[15px] text-ink-secondary">
        Run your capstone against the official evaluation of Cog*Works 2026.
      </p>

      <div className="mt-7 flex flex-wrap items-center gap-4">
        {authed ? (
          <Link
            to={nextStagePath(session!)}
            className="u-pressable inline-flex h-11 items-center bg-ink px-6 text-[13.5px] font-medium tracking-wide text-paper-raised transition-colors duration-150 hover:bg-ink/90"
          >
            Open Dashboard
          </Link>
        ) : (
          <Link
            to="/signin"
            className="u-pressable inline-flex h-11 items-center gap-2.5 bg-ink px-6 text-[13.5px] font-medium tracking-wide text-paper-raised transition-colors duration-150 hover:bg-ink/90"
          >
            <GitHubIcon />
            Sign in with GitHub
          </Link>
        )}
        <Link
          to="/leaderboard"
          className="inline-flex min-h-11 items-center font-mono text-[11.5px] tracking-[0.09em] text-ink-secondary uppercase underline decoration-rule underline-offset-8 hover:text-ink"
        >
          Standings
        </Link>
      </div>

      {/* ── Setup ── */}
      <section className="mt-16">
        <h2 className="u-kicker">Setup</h2>
        <ol className="mt-2">
          <Step n={1} title="Fork the template">
            {template ? (
              <a
                href={`https://github.com/${template}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[13px] text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
              >
                github.com/{template} ↗
              </a>
            ) : (
              <p className="text-[14px] text-ink-secondary">
                Fork the course template repository your instructor shared, and keep
                your fork public so the portal can verify it.
              </p>
            )}
          </Step>

          <Step n={2} title="Set up your machine">
            <p className="text-[14px] text-ink-secondary">
              Clone your fork, install the course environment, and install the
              CogWorks CLI. Sign in and the setup page walks you through it with
              the exact commands for your track, in order.
            </p>
          </Step>

          <Step n={3} title="Practice locally">
            <p className="text-[14px] text-ink-secondary">
              Local runs use the same checks and the same scorer as hosted runs,
              with no limit. Get a score you like here before spending a hosted run.
            </p>
          </Step>

          <Step n={4} title="Connect and run">
            <p className="text-[14px] text-ink-secondary">
              After you sign in with GitHub and connect your fork, your team gets ten
              hosted practice runs and three official attempts. Your team picks which
              result to publish.
            </p>
            {!authed && (
              <Link
                to="/signin"
                className="mt-3 inline-flex min-h-10 items-center font-mono text-[11.5px] tracking-[0.09em] text-detect-deep uppercase underline decoration-detect/40 underline-offset-4 hover:decoration-detect"
              >
                Sign in →
              </Link>
            )}
          </Step>
        </ol>
      </section>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-[44px_1fr] gap-x-4 border-t border-rule-soft py-6 first:border-t-0">
      <span className="u-tnum pt-0.5 font-serif text-xl font-semibold text-detect">
        {String(n).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        <div className="mt-2.5">{children}</div>
      </div>
    </li>
  );
}
