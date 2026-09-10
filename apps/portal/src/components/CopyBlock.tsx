import { useEffect, useRef, useState } from "react";

/** A copyable command line: mono, single action, 44px target. */
export function CopyBlock({
  text,
  className = "",
  wrap = false,
}: {
  text: string;
  className?: string;
  /** Let a long command wrap instead of scrolling out of view. The pinned
   *  install is 189 characters and the part that identifies the commit is at
   *  the end, so in a narrow column scrolling hides exactly the load-bearing
   *  part. Off by default: a short command reads better on one line. */
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
        className={`min-w-0 flex-1 border border-rule bg-paper-sunken px-3 py-2.5 font-mono text-[12.5px] text-ink ${
          wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "overflow-x-auto whitespace-pre"
        }`}
      >
        {text}
      </code>
      <button
        type="button"
        onClick={copy}
        className="u-pressable min-w-11 border border-l-0 border-rule bg-paper-raised px-3 font-mono text-[11px] tracking-[0.08em] text-ink-secondary uppercase transition-colors duration-150 hover:text-ink"
      >
        {copied ? "ok" : "copy"}
        <span className="sr-only">Copy command</span>
      </button>
    </div>
  );
}
