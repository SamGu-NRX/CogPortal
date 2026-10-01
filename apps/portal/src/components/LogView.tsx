import { useState } from "react";
import { Veil } from "./Veil";

const TAIL = 14;

/**
 * A practice run's capped log: a printout excerpt on sunken paper, not a
 * terminal theme (plan §8).
 *
 * Folded by default. The finding, the failure card and the readings already
 * say what the run did; the log is the raw material a student opens when one
 * of those surprises them, and two hundred lines of pip output above the fold
 * would bury the rest of the page. Once open it shows the tail first, because
 * the most recent lines carry the diagnosis, and the whole log is one click
 * further.
 *
 * The excerpt is a focusable region, so a keyboard can scroll a long line or
 * the full log with the arrow keys; opening the fold from the keyboard moves
 * focus into it.
 */
export function LogView({ log }: { log: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = log.trimEnd().split("\n");
  const clipped = lines.length > TAIL && !expanded;
  const shown = clipped ? lines.slice(-TAIL) : lines;

  return (
    <Veil
      count={1}
      peek={0}
      moreLabel="Show the log"
      fewerLabel="Hide the log"
      detail={`${lines.length} ${lines.length === 1 ? "line" : "lines"}, capped`}
      focusSelector="[data-log]"
    >
      <pre
        data-log
        tabIndex={0}
        role="region"
        aria-label={clipped ? `Run log, last ${TAIL} of ${lines.length} lines` : "Run log"}
        className="log-scroll max-h-[24rem] overflow-auto rounded-control border border-rule bg-paper-sunken px-3.5 py-2.5 font-mono text-[12.5px] leading-[1.65] text-ink-secondary focus-visible:outline-offset-1"
      >
        {clipped ? "…\n" : ""}
        {shown.join("\n")}
      </pre>
      {lines.length > TAIL && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="u-pressable inline-flex min-h-11 items-center text-[13.5px] font-semibold text-ink-secondary underline decoration-rule-strong underline-offset-4 hover:text-ink"
        >
          {expanded ? `Show only the last ${TAIL} lines` : `Show all ${lines.length} lines`}
        </button>
      )}
    </Veil>
  );
}
