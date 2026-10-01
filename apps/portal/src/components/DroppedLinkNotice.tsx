import { useState } from "react";
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
 */
export function DroppedLinkNotice({ className = "" }: { className?: string }) {
  const [kind] = useState(takeDroppedDeviceLink);
  if (!kind) return null;
  return (
    <div
      role="status"
      className={`rounded-control border-l-2 border-ink bg-paper-raised px-4 py-3 text-[14px] leading-[1.55] text-ink-secondary ${className}`}
    >
      {kind === "device" ? (
        <>
          <p className="font-semibold text-ink">Your device link is on hold</p>
          <p className="mt-1">
            It needs a team first. Finish getting started, then run{" "}
            <code className="font-mono text-[13px] text-ink [overflow-wrap:anywhere]">{deviceLinkCommand(window.location.origin)}</code>{" "}
            again.
          </p>
        </>
      ) : (
        <>
          <p className="font-semibold text-ink">Your Discord link is on hold</p>
          <p className="mt-1">
            It needs a team first. Finish getting started, then start the link
            again from Discord.
          </p>
        </>
      )}
    </div>
  );
}
