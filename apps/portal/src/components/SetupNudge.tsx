import { ArrowRight01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Link } from "react-router";
import {
  useSession,
  useSetupState,
  useTeam,
} from "@/lib/queries";
import {
  dismissSetup,
  isSetupDismissed,
  setupProgress,
} from "@/lib/setup-progress";

/**
 * Slim dashboard reminder that the setup guide keeps your place. Disappears
 * on completion, or for good when dismissed — a guide, not a nag.
 */
export function SetupNudge() {
  const team = useTeam();
  const { data: session } = useSession();
  const setupState = useSetupState();
  const [hidden, setHidden] = useState(false);

  if (hidden || !team.data || !session?.user) return null;
  const login = session.user.login;
  if (isSetupDismissed(team.data.id, login)) return null;

  const { done, total } = setupProgress(
    team.data.id,
    login,
    team.data.isAdmin ? "created" : "joined",
    {
      teammates: team.data.members.length >= 2,
      terminal: setupState.data?.verified,
    },
  );
  if (done >= total) return null;

  return (
    <div className="anim-rise mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border border-rule bg-paper-raised px-4 py-3">
      <span className="u-kicker">Getting set up</span>

      <span aria-hidden="true" className="flex items-center gap-1">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`size-2 transition-colors duration-150 ${
              i < done ? "bg-verify" : "border border-rule bg-paper-sunken"
            }`}
          />
        ))}
      </span>

      <span className="text-[13px] text-ink-secondary">
        {done} of {total} steps done
      </span>

      <span className="ml-auto flex items-center gap-1">
        <Link
          to="/setup"
          className="u-pressable inline-flex min-h-9 items-center gap-1.5 px-2 font-mono text-[11px] tracking-[0.08em] text-ink-secondary uppercase hover:text-ink"
        >
          Continue
          <HugeiconsIcon icon={ArrowRight01Icon} size={13} strokeWidth={1.8} aria-hidden="true" />
        </Link>
        <button
          type="button"
          aria-label="Dismiss the setup reminder"
          onClick={() => {
            dismissSetup(team.data.id, login);
            setHidden(true);
          }}
          className="u-pressable flex min-h-9 min-w-9 items-center justify-center text-ink-faint transition-colors duration-150 hover:text-ink"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
