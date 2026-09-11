import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";

/** A copyable command line: mono, single action, 44px target. */
export function CopyBlock({
  text,
  className = "",
  wrap = false,
}: {
  text: string;
  className?: string;
  /** Let a long command wrap instead of scrolling out of view.
   *
   *  Turn it on when the tail is worth reading: the pinned install is 189
   *  characters and ends in the commit it pins, so scrolling would hide the
   *  load-bearing part. Leave it off when the tail is opaque, like a signed
   *  token, where wrapping only trades a line nobody reads for a block that
   *  crowds out the page. Off by default. */
  wrap?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className={`flex items-stretch gap-0 ${className}`}>
      <code
        // A scrolling box has to be reachable by keyboard to be scrollable by
        // one, the way the run console's log is. A wrapped block scrolls
        // nowhere, so it takes no tab stop.
        tabIndex={wrap ? undefined : 0}
        className={`min-w-0 flex-1 border border-rule bg-paper-sunken px-3 py-2.5 font-mono text-[12.5px] text-ink ${
          wrap
            ? "whitespace-pre-wrap [overflow-wrap:anywhere]"
            : "overflow-x-auto whitespace-pre focus-visible:outline-offset-[-2px]"
        }`}
      >
        {text}
      </code>
      {/* Same control as the code block's, so one gesture means one thing
          across the page. */}
      <button
        type="button"
        onClick={copy}
        title={copied ? "Copied" : "Copy command"}
        className="u-pressable flex min-w-11 items-center justify-center border border-l-0 border-rule bg-paper-raised px-3 transition-colors duration-150 hover:border-ink-secondary"
      >
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          size={13}
          strokeWidth={1.8}
          className={copied ? "text-verify" : "text-ink-faint"}
          aria-hidden="true"
        />
        <span className="sr-only">{copied ? "Copied" : "Copy command"}</span>
      </button>
    </div>
  );
}
