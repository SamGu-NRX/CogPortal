import { Link, Navigate } from "react-router";
import { GitHubIcon } from "@/components/GitHubIcon";
import { nextStagePath } from "@/App";
import { useSession } from "@/lib/queries";
import { pendingConnectionReturn } from "@/lib/pending-return";

/**
 * The front door. It cannot carry the setup commands: they need a clone URL
 * and a track, and a signed-out page has neither, so a student who followed
 * them literally reached "cogworks: command not found". The commands live on
 * /setup, which knows both. This page shows the shape of the path and opens
 * the door to it.
 */
export function Landing() {
  const { data: session } = useSession();
  const authed = Boolean(session?.user);
  const pendingReturn = session?.user ? pendingConnectionReturn() : null;
  if (pendingReturn) return <Navigate to={pendingReturn} replace />;

  return (
    <div className="anim-rise mx-auto w-full max-w-2xl py-14">
      <h1 className="mt-3 text-4xl">
        The Cog<span className="text-detect">*</span>Works benchmark.
      </h1>

      {/* The whole path, in the words the terminal uses for it. "fork" was a
          step here while a fork was required. It is one way to get a
          repository now, not the way, so the step is what every path has in
          common. */}
      <p className="mt-4 font-mono text-[12.5px] tracking-[0.08em] text-ink-secondary">
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
    </div>
  );
}
