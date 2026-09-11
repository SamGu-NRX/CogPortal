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
export function DroppedLinkNotice() {
  const [kind] = useState(takeDroppedDeviceLink);
  if (!kind) return null;
  return (
    <p
      role="status"
      className="mb-6 border border-rule bg-paper-sunken px-4 py-3 text-[13px] text-ink-secondary"
    >
      {kind === "device" ? (
        <>
          A device was waiting for approval, but you need a team first. Finish
          this step, then run <code className="font-mono text-[12px] [overflow-wrap:anywhere]">{deviceLinkCommand(window.location.origin)}</code> again.
        </>
      ) : (
        <>
          A Discord link was waiting, but you need a team first. Finish this
          step, then start the link again from Discord.
        </>
      )}
    </p>
  );
}
