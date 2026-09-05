import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import type { SetupCommand } from "@/lib/setup-progress";

/**
 * What "Copy all" puts on the clipboard. The comments are for reading, not
 * for pasting, so they do not travel.
 */
export function commandText(lines: readonly SetupCommand[]): string {
  return lines.map((line) => line.command).join("\n");
}

/**
 * The setup page's whole instrument: the commands in run order, in one code
 * frame, each with a gutter cell recording whether the portal has seen its
 * result yet.
 *
 * The gutter is the reason this is a sheet rather than a stack of steps. A
 * check reports several facts at once, so several cells fill at once; a
 * numbered step list would imply they complete one at a time. A filled cell
 * also drops its command to faint ink, which leaves the unfinished commands
 * as the only full-contrast text on the page.
 */
export function CommandSheet({
  lines,
  label,
}: {
  lines: readonly SetupCommand[];
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(commandText(lines));
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      /* a blocked clipboard leaves the commands on screen to select by hand */
    }
  };

  return (
    <div className="relative border border-rule bg-paper-sunken px-3.5 py-3 font-mono">
      <ol aria-label={label} className="space-y-3.5">
        {lines.map((line) => (
          <li
            key={line.command}
            className="grid grid-cols-[15px_minmax(0,1fr)] gap-x-3 gap-y-1"
          >
            <p className="col-start-2 pr-16 text-[11.5px] leading-[1.5] text-ink-faint italic">
              {line.comment}
            </p>
            <GutterCell verified={line.verified} />
            <code className="col-start-2 text-[12.5px] leading-[1.6] [overflow-wrap:anywhere] whitespace-pre-wrap">
              <span className="sr-only">
                {line.verified ? "Verified. " : "Not verified yet. "}
              </span>
              <span
                className={`transition-colors duration-150 ${
                  line.verified ? "text-ink-faint" : "text-ink"
                }`}
              >
                {line.command}
              </span>
            </code>
          </li>
        ))}
      </ol>

      <button
        type="button"
        onClick={copyAll}
        className="u-pressable absolute top-1.5 right-1.5 min-h-7 border border-transparent bg-paper-sunken/90 px-2 font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase transition-colors duration-150 hover:border-rule hover:text-ink"
      >
        {copied ? "copied" : "copy all"}
        <span className="sr-only">Copy every command, without the comments</span>
      </button>
    </div>
  );
}

/** An empty rule box until the portal sees the result, then a tick. The tick
 *  is what moves when a check reports; `anim-rise` is the same 200ms quartic
 *  the rest of the interface enters on, and app.css drops it under reduced
 *  motion. Only a newly mounted tick animates, so a report that fills three
 *  cells does not re-run the ones already filled. */
function GutterCell({ verified }: { verified: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-[3px] flex size-[15px] shrink-0 items-center justify-center border transition-colors duration-150 ${
        verified
          ? "border-verify/50 bg-verify-wash text-verify-deep"
          : "border-rule bg-paper-raised"
      }`}
    >
      {verified && (
        <span className="anim-rise flex">
          <HugeiconsIcon icon={Tick02Icon} size={11} strokeWidth={2.6} />
        </span>
      )}
    </span>
  );
}
