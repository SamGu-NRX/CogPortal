import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";

/** Shows the short commit SHA; copies the full scientific record. */
export function ShaChip({ sha, shortSha }: { sha: string; shortSha: string }) {
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
    // Keep the button focusable while suppressing overlapping writes.
    if (copying.current) return;
    copying.current = true;
    if (timer.current) clearTimeout(timer.current);
    setCopyStatus("idle");
    try {
      await navigator.clipboard.writeText(sha);
      setCopyStatus("copied");
      timer.current = setTimeout(() => setCopyStatus("idle"), 1400);
    } catch {
      setCopyStatus("failed");
    } finally {
      copying.current = false;
    }
  };

  return (
    <span className="inline-flex min-w-0 max-w-full flex-col items-start align-middle">
      <button
        type="button"
        onClick={copy}
        title={sha}
        aria-label={`Copy full commit SHA ${sha}`}
        className="u-pressable inline-flex min-h-7 items-center gap-1.5 border border-rule bg-paper-sunken px-2 font-mono text-[12px] text-ink-secondary transition-colors duration-150 hover:border-ink-secondary hover:text-ink"
      >
        <span className="u-tnum">{shortSha}</span>
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          size={13}
          strokeWidth={1.8}
          className={copied ? "text-verify" : "text-ink-faint"}
          aria-hidden="true"
        />
      </button>
      <span role="status" className={copyStatus === "failed" ? "mt-2 w-72 max-w-full text-left font-sans text-[13px] tracking-normal text-detect-deep normal-case" : "sr-only"}>
        {copyStatus === "failed" ? "Couldn't copy. Copy the full SHA below manually, or try again." : copied ? "Copied." : ""}
      </span>
      {copyStatus === "failed" && (
        <textarea
          aria-label="Full commit SHA"
          readOnly
          value={sha}
          rows={2}
          className="mt-1 w-72 max-w-full resize-none border border-rule bg-paper-sunken px-2 py-1 font-mono text-[12px] leading-relaxed tracking-normal text-ink"
        />
      )}
    </span>
  );
}
