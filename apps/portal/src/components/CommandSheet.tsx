import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SetupCommand, SetupCommandId } from "@/lib/setup-progress";

/**
 * What "Copy all" puts on the clipboard: the commands, in order, and nothing
 * else. A student pastes this into a terminal.
 */
export function commandText(lines: readonly SetupCommand[]): string {
  return lines.map((line) => line.command).join("\n");
}

/** What the page says about one command, beside the command itself. */
export interface CommandNote {
  /** What this step is, in the words a student would use for it. */
  title: string;
  /** Why it matters. One or two sentences, before the command. */
  why: ReactNode;
  /** The thing that goes wrong here, when there is a known one. */
  help?: ReactNode;
}

/**
 * The setup page's instrument: the commands in run order, each under its title
 * and reason, each with a gutter cell recording whether the portal has seen its
 * result yet.
 *
 * The gutter, rather than a step number, is what carries progress. A single
 * `check` reports four facts in one request (cli.py sends clone, environment,
 * project and wiring together), so cells fill in groups and a numbered list
 * would promise something the tool does not do. A filled cell also drops its
 * command to faint ink, which leaves the unfinished commands as the only
 * full-contrast text on the page.
 *
 * The commands and their verified state come from `setup-progress.ts`; the
 * prose comes from the page, keyed by id, so no command exists twice.
 */
export function CommandSheet({
  lines,
  label,
  notes,
}: {
  lines: readonly SetupCommand[];
  label: string;
  /** One note per command id. Exhaustive, so a new command cannot render bare. */
  notes: Record<SetupCommandId, CommandNote>;
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
    <div>
      <div className="flex items-center justify-between border-b border-rule-soft pb-2">
        <h2 className="u-kicker">In your terminal, top to bottom</h2>
        <button
          type="button"
          onClick={copyAll}
          className="u-pressable min-h-7 border border-transparent px-2 font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase transition-colors duration-150 hover:border-rule hover:text-ink"
        >
          {copied ? "copied" : "copy all"}
          <span className="sr-only">Copy every command</span>
        </button>
      </div>

      <ol aria-label={label}>
        {lines.map((line) => {
          const note = notes[line.id];
          return (
            <li key={line.id} className="border-b border-rule-soft py-5 last:border-b-0">
              <h3 className="text-[15px] font-semibold text-ink">{note.title}</h3>
              <p className="mt-1.5 max-w-[58ch] text-[13.5px] leading-[1.6] text-ink-secondary">
                {note.why}
              </p>
              <div className="mt-3 grid grid-cols-[15px_minmax(0,1fr)] items-start gap-x-3 border border-rule bg-paper-sunken px-3 py-2.5 font-mono">
                <GutterCell verified={line.verified} />
                <code className="text-[12.5px] leading-[1.6] [overflow-wrap:anywhere] whitespace-pre-wrap">
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
              </div>
              {note.help && (
                // ink-secondary, not ink-faint. This line carries the one
                // recovery instruction on the page, and faint ink on paper is
                // about 3.3:1, under the 4.5:1 that text this size needs.
                <p className="mt-2 max-w-[58ch] text-[12.5px] leading-[1.55] text-ink-secondary">
                  {note.help}
                </p>
              )}
            </li>
          );
        })}
      </ol>
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
