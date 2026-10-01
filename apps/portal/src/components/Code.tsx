import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { CodeContent, type CodeLang } from "./CodeContent";

export function Code({
  code,
  lang,
  wrap = false,
}: {
  code: string;
  lang: CodeLang;
  /** Let a long line wrap instead of scrolling out of view. `.code-block pre`
   *  scrolls by default, which suits a short snippet; the setup page's pinned
   *  install is 189 characters and ends in the commit it pins, so scrolling
   *  would hide the part that identifies it. */
  wrap?: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copying = useRef(false);
  const copied = copyStatus === "copied";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    // Suppress overlapping writes without disabling the focused button.
    if (copying.current) return;
    copying.current = true;
    if (timer.current) clearTimeout(timer.current);
    setCopyStatus("idle");
    try {
      await navigator.clipboard.writeText(code);
      setCopyStatus("copied");
      timer.current = setTimeout(() => setCopyStatus("idle"), 1400);
    } catch {
      setCopyStatus("failed");
    } finally {
      copying.current = false;
    }
  };

  return (
    <div
      className={`code-block group relative rounded-surface border border-rule bg-paper-sunken/70 px-4 py-3.5 font-mono ${
        wrap ? "is-wrapped" : ""
      }`}
    >
      <CodeContent code={code} lang={lang} className="text-[13px] leading-[1.65] text-ink" />
      {/* Keep the action's name stable; the status below announces its result. */}
      <button
        type="button"
        onClick={copy}
        title="Copy command"
        className="u-pressable u-hit-44 absolute top-2 right-2 flex min-h-7 min-w-7 items-center justify-center gap-1 rounded-control border border-transparent bg-paper-sunken px-1.5 text-ink-secondary transition-colors duration-150 hover:border-rule hover:bg-paper-raised hover:text-ink"
      >
        {/* Seen, not heard: the status line below announces the result. */}
        {copied && (
          <span aria-hidden="true" className="anim-rise font-sans text-[12px] font-semibold text-verify-deep">
            Copied
          </span>
        )}
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          size={15}
          strokeWidth={1.8}
          className={copied ? "text-verify" : undefined}
          aria-hidden="true"
        />
        <span className="sr-only">Copy command</span>
      </button>
      <p role="status" className={copyStatus === "failed" ? "mt-2 font-sans text-[13px] text-detect-deep" : "sr-only"}>
        {copyStatus === "failed" ? "Couldn't copy. Select the command and copy it manually." : copied ? "Copied." : ""}
      </p>
    </div>
  );
}
