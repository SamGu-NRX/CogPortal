import type { ReactNode } from "react";
import { Link, Navigate } from "react-router";
import { OFFICIAL_LIMIT, PRACTICE_LIMIT } from "@cogworks/contracts/schema";
import { GitHubIcon } from "@/components/GitHubIcon";
import { nextStagePath } from "@/App";
import { useSession } from "@/lib/queries";
import { pendingConnectionReturn } from "@/lib/pending-return";

/**
 * The front door, for someone who has been sent a link and does not yet know
 * what this is.
 *
 * It cannot carry the setup commands: those need a clone URL and a track, and
 * a signed-out page has neither, so a student who followed them literally
 * reached "cogworks: command not found". The commands live on /setup, which
 * knows both. What belongs here is the shape of the work, so that the first
 * command someone types is one they understand the reason for.
 *
 * This page briefly said only "sign in · connect · clone · check · run" over
 * an empty sheet of paper. The sequence is worth keeping and is not an
 * explanation: a reader who does not already know what CogPortal does learns
 * nothing from five verbs.
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
      <p className="mt-3 max-w-[52ch] text-[15px] leading-[1.6] text-ink-secondary">
        Run your capstone against the official evaluation of Cog*Works 2026. It
        scores the code your team already wrote, on your machine as often as you
        like and on ours when you're ready to publish a result.
      </p>

      {/* The same five words the terminal uses, so the sequence below and the
          prompts a student will actually see name the steps identically. */}
      <p className="mt-5 font-mono text-[12.5px] tracking-[0.08em] text-ink-secondary">
        sign in · connect · clone · check · run
      </p>

      <div className="mt-7 flex flex-wrap items-center gap-4">
        {authed ? (
          <Link
            to={nextStagePath(session!)}
            className="u-pressable inline-flex h-11 items-center bg-ink px-6 text-[13.5px] font-medium tracking-wide text-paper-raised transition-colors duration-150 hover:bg-ink/90"
          >
            {session!.team ? "Open Dashboard" : "Continue setup"}
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
          Results
        </Link>
      </div>

      <section className="mt-16">
        <h2 className="u-kicker">How it goes</h2>
        {/* A real sequence, so it is numbered. You cannot check a repository
            you have not connected, or spend a hosted run before a local one
            works. */}
        <ol className="mt-2">
          <Step n={1} title="Bring a repository">
            <p>
              Your team works in one GitHub repository, and every hosted attempt
              runs from it rather than from somebody's laptop. That is what makes
              a result something another person can go and read.
            </p>
            {template ? (
              <p className="mt-2">
                Fork the course template:{" "}
                <a
                  href={`https://github.com/${template}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[13px] text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
                >
                  github.com/{template} ↗
                </a>
                , or connect a repository your team already has.
              </p>
            ) : (
              <p className="mt-2">
                A repository your team already has is fine. If your instructor
                shares a template, forking it is the easy start.
              </p>
            )}
          </Step>

          <Step n={2} title="Set up your machine">
            <p>
              Clone the repository, activate the course environment for your
              week, and install the CogWorks tool. Sign in and the setup page
              gives you the exact commands for your track, and records what the
              last one reports back.
            </p>
          </Step>

          <Step n={3} title="Practice on your own machine">
            <p>
              <code className="font-mono text-[12.5px]">cogworks run</code> scores
              your code locally, with the same scorer the hosted run uses. There
              is no limit on local runs, so this is where the work happens: read
              what it says, change something, run it again.
            </p>
          </Step>

          <Step n={4} title="Run it here when it's ready">
            <p>
              A hosted run repeats that scoring on our machines, from the commit
              you pushed, so the number belongs to code anyone can check out. On
              each benchmark your team gets {PRACTICE_LIMIT} hosted practice runs
              and {OFFICIAL_LIMIT} official attempts, and you choose which result
              goes on the board.
            </p>
            {!authed && (
              <Link
                to="/signin"
                className="u-pressable mt-3 inline-flex min-h-10 items-center font-mono text-[11.5px] tracking-[0.09em] text-detect-deep uppercase underline decoration-detect/40 underline-offset-4 hover:decoration-detect"
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

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[44px_1fr] gap-x-4 border-t border-rule-soft py-6 first:border-t-0">
      <span className="u-tnum pt-0.5 font-serif text-xl font-semibold text-detect">
        {String(n).padStart(2, "0")}
      </span>
      <div className="min-w-0 space-y-0 text-[14px] leading-[1.6] text-ink-secondary">
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        <div className="mt-2.5">{children}</div>
      </div>
    </li>
  );
}
