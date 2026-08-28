import { useState } from "react";
import { takeDroppedDeviceLink } from "@/lib/pending-return";

/**
 * Says what the portal just declined to do.
 *
 * `cogworks link` is the first command in the CLI's own workflow, so students
 * run it before they have a team. The stage guard sends them to the step they
 * still owe and the device code dies on the way: the browser said nothing and
 * the terminal polled in silence until the code expired ten minutes later.
 * Naming the loss is most of the fix, because the recovery is one command.
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
          this step, then run <code className="font-mono text-[12px]">cogworks link</code> again.
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
