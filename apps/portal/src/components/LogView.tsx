import { useState } from "react";

/**
 * Capped practice-run log — a printout excerpt on sunken paper, not a
 * terminal theme (plan §8). Collapsed to the tail by default because the
 * most recent lines carry the diagnosis.
 */
export function LogView({ log }: { log: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = log.trimEnd().split("\n");
  const TAIL = 14;
  const shown = expanded ? lines : lines.slice(-TAIL);

  return (
    <div>
      {lines.length > TAIL && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="u-pressable mb-2 min-h-8 font-mono text-[11px] tracking-[0.08em] text-ink-secondary uppercase hover:text-ink"
        >
          {expanded
            ? "collapse to tail"
            : `show all ${lines.length} lines`}
        </button>
      )}
      <pre className="log-scroll max-h-80 overflow-auto border border-rule bg-paper-sunken px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-secondary">
        {!expanded && lines.length > TAIL ? "…\n" : ""}
        {shown.join("\n")}
      </pre>
    </div>
  );
}
