import { useEffect, useRef, useState } from "react";

/**
 * The commit SHA is the scientific record — always mono, always copyable
 * (copies the full 40 characters, shows the short form).
 */
export function ShaChip({ sha, shortSha }: { sha: string; shortSha: string }) {
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
      await navigator.clipboard.writeText(sha);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable; the short sha is still visible */
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={sha}
      className="u-pressable inline-flex min-h-7 items-center gap-1.5 border border-rule bg-paper-sunken px-2 font-mono text-[12px] text-ink-secondary transition-colors duration-150 hover:border-ink-secondary hover:text-ink"
    >
      <span className="u-tnum">{copied ? "copied" : shortSha}</span>
      <svg viewBox="0 0 12 12" className="size-3 opacity-60" aria-hidden="true">
        <rect x="3.5" y="3.5" width="7" height="7" fill="none" stroke="currentColor" />
        <path d="M8.5 3.5 V1.5 H1.5 V8.5 H3.5" fill="none" stroke="currentColor" />
      </svg>
      <span className="sr-only">Copy full commit SHA {sha}</span>
    </button>
  );
}
