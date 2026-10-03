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
 * URL, and the waiting CLI completed. Naming the loss is most of the fix,
 * because the recovery is reopening that link or running one command.
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
              ? "Linking a machine needs a team, and this account isn't on one, so the terminal will keep waiting until its code expires. Ctrl+C stops it."
              : "Linking Discord needs a team, and this account isn't on one."}
          </p>
          <p className="mt-2">
            The console doesn't need a team. To use {kind === "device" ? "the CLI" : "Discord"} yourself,{" "}
            <Link to="/connect" className="u-link">join a team</Link>, then{" "}
            {kind === "device" ? <>run {command} again.</> : "start the link again from Discord."}
          </p>
        </>
      ) : kind === "device" ? (
        <p className="mt-1">
          It needs a team first. Finish getting started, then run {command} again.
        </p>
      ) : (
        <p className="mt-1">
          It needs a team first. Finish getting started, then start the link
          again from Discord.
        </p>
      )}
    </div>
  );
}
