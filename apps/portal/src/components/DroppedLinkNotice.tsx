import { useState } from "react";
import { Link } from "react-router";
import { takeDroppedDeviceLink } from "@/lib/pending-return";
import { deviceLinkCommand } from "@/lib/setup-progress";

/**
 * Says what the portal just declined to do.
 *
 * `cogworks link` is the first command in the CLI's own workflow, so students
 * run it before they have a team. The stage guard sends them to the step they
 * still owe, and what is lost on the way is the browser's route back to the
 * approval page: it said nothing, so the terminal appeared to poll for no
 * reason. The authorization itself survives. Measured on 2026-09-10: a fresh
 * account was bounced to /join, joined a team, reopened the original approval
 * URL, and the waiting CLI completed. So the notice names the loss, and once
 * they have a team Setup offers the same approval again while its code is
 * still valid (HeldDeviceLinkOffer). Ctrl+C is named for a wait they'd rather
 * abandon, since telling them only to run the command again left the first
 * terminal polling until its code ran out.
 *
 * Staff without a team land on the console instead (`nextStagePath`), where a
 * team is not owed, so `teamOptional` says the terminal can be stopped and
 * offers joining a team as a choice rather than the next step.
 */
export function DroppedLinkNotice({
  className = "",
  teamOptional = false,
}: {
  className?: string;
  teamOptional?: boolean;
}) {
  const [kind] = useState(takeDroppedDeviceLink);
  if (!kind) return null;
  const command = (
    <code className="font-mono text-[13px] text-ink [overflow-wrap:anywhere]">
      {deviceLinkCommand(window.location.origin)}
    </code>
  );
  return (
    <div
      role="status"
      className={`rounded-control border-l-2 border-ink bg-paper-raised px-4 py-3 text-[14px] leading-[1.55] text-ink-secondary ${className}`}
    >
      <p className="font-semibold text-ink">
        {kind === "device" ? "Your device link is on hold" : "Your Discord link is on hold"}
      </p>
      {teamOptional ? (
        <>
          <p className="mt-1">
            {kind === "device"
              ? "Linking a machine needs a team, and this account isn't on one. If that terminal is still waiting, Ctrl+C stops it."
              : "Linking Discord needs a team, and this account isn't on one."}
          </p>
          <p className="mt-2">
            The console doesn't need a team. To use {kind === "device" ? "the CLI" : "Discord"} yourself,{" "}
            <Link to="/connect" className="u-link">join a team</Link>
            {kind === "device" ? (
              <>; Setup in this tab then offers this link while its code is still valid, or run {command} again.</>
            ) : (
              <>, then start the link again from Discord.</>
            )}
          </p>
        </>
      ) : kind === "device" ? (
        <>
          <p className="mt-1">
            It needs a team first. Once you've joined one, Setup in this tab offers the link again while its
            code is still valid.
          </p>
          <p className="mt-2">
            If you'd rather not wait, press Ctrl+C in that terminal; run {command} again when you're ready.
          </p>
        </>
      ) : (
        <p className="mt-1">
          It needs a team first. Finish getting started, then start the link
          again from Discord.
        </p>
      )}
    </div>
  );
}
