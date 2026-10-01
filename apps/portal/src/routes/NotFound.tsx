import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useLocation } from "react-router";
import { nextStagePath } from "@/App";
import { CornerBrackets } from "@/components/Brackets";
import { buttonClass } from "@/components/Button";
import { useSession } from "@/lib/queries";

/**
 * The way back depends on who is reading. A signed-in student is sent to the
 * step they still owe (or their runs), which is almost always where the
 * broken link meant to go; staff without a team go to Admin, and anyone else
 * gets the front page.
 */
export function NotFound() {
  const { pathname } = useLocation();
  const { data: session } = useSession();
  const signedIn = Boolean(session?.user);

  const home = signedIn ? nextStagePath(session!) : "/";
  const homeLabel = !signedIn
    ? "Go to the front page"
    : session!.team
      ? "Go to your runs"
      : home === "/admin"
        ? "Go to Admin"
        : "Continue getting started";

  return (
    <div className="page page-narrow anim-rise">
      <p className="u-eyebrow">Page not found</p>
      <h1 className="mt-2 text-[clamp(2rem,1.5rem+2vw,2.5rem)] text-ink">
        There's nothing at this address.
      </h1>
      <p className="mt-3 text-[16px] leading-[1.6] text-ink-secondary">
        The link may be out of date, or a character went missing when it was
        copied. This is the address we looked up:
      </p>

      {/* The detection bracket around what the portal looked for and didn't
          find. React escapes the text, and it is labeled as the address so
          a crafted link can't pass its path off as the page's own words. */}
      <div className="relative mt-5 px-4 py-3">
        <CornerBrackets size={10} thickness={1.25} className="text-rule-strong" />
        <code className="block font-mono text-[14px] text-ink [overflow-wrap:anywhere]">{pathname}</code>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link to={home} className={buttonClass("primary")}>
          {homeLabel}
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} aria-hidden="true" />
        </Link>
        <Link to="/leaderboard" className={buttonClass("quiet")}>
          See the leaderboard
        </Link>
      </div>
    </div>
  );
}
