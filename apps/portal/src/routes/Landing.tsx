import { Link, Navigate } from "react-router";
import { Code } from "@/components/Code";
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
                Fork the course template repository your instructor shared. Keep
                your fork public.
              </p>
            )}
          </Step>

          <Step n={2} title="Install and register your adapter">
            <Code lang="bash" code={"pip install -e ."} />
            <p className="mt-3 mb-1.5 text-[13px] text-ink-secondary">
              The template declares your entry point in{" "}
              <code className="text-[12px] text-ink">pyproject.toml</code>:
            </p>
            <Code
              lang="toml"
              code={`[project.entry-points."cogworks.submissions.v1"]\nvision-recognition = "your_package.portal:Submission"`}
            />
          </Step>

          <Step n={3} title="Practice locally">
            <Code
              lang="bash"
              code={`cogbench doctor --benchmark vision-recognition\ncogbench run --benchmark vision-recognition`}
            />
            <p className="mt-2 text-[13px] text-ink-secondary">
              Same checks and scorer as the hosted run. Unlimited.
            </p>
          </Step>

          <Step n={4} title="Connect and run">
            <p className="text-[14px] text-ink-secondary">
              Sign in with GitHub, connect your fork, and run the hosted
              benchmark. Ten hosted practice runs, three official attempts —
              your team picks which result publishes.
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
