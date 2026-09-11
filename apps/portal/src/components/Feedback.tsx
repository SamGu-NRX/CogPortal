import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import { queryErrorState } from "@/lib/query-error-state";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { Panel } from "./Panel";

/**
 * Whole seconds this mark has been up, but only once the wait has passed
 * `after`. Null before then, so a query that resolves quickly never flashes a
 * counter at somebody who was not waiting yet.
 */
function useWaitedSeconds(after: number): number | null {
  const [seconds, setSeconds] = useState<number | null>(null);

  useEffect(() => {
    const start = Date.now();
    const tick = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      // Setting the same value is a no-op in React, so the ticks before
      // `after` cost no renders.
      setSeconds(elapsed >= after ? elapsed : null);
    }, 1000);
    return () => clearInterval(tick);
  }, [after]);

  return seconds;
}

/**
 * Quiet loading mark; content arrives with a 200ms rise, no spinners.
 *
 * Past three seconds the wait is itself the news: an ellipsis that has been
 * sitting there for forty seconds looks exactly like one that has been sitting
 * there for four, and a student cannot tell a slow query from a stuck page.
 * The label already names what is being waited on, so the mark only has to add
 * how long it has been waiting.
 */
export function LoadingMark({ label = "Loading" }: { label?: string }) {
  const waited = useWaitedSeconds(3);

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-16 font-mono text-[11px] tracking-[0.09em] text-ink-faint uppercase"
    >
      <span aria-hidden="true" className="anim-live size-[7px] bg-detect" />
      <span>
        {label}
        {waited === null ? (
          "…"
        ) : (
          <>
            {" "}
            {/* Hidden from assistive technology on purpose. This sits inside a
                live region, so a counter that changes every second would be one
                interruption per second; the label alone stays announced.
                anim-rise carries its own prefers-reduced-motion rule
                (styles/app.css:254), and inline-block is what lets its
                transform apply to a span. The seconds keep their case because
                "s" is the unit and "S" is a different one. */}
            <span aria-hidden="true" className="anim-rise inline-block normal-case">
              · {waited} s
            </span>
          </>
        )}
      </span>
    </div>
  );
}

/** The 404 escape hatch, in the shape NotFound.tsx already uses. */
const ESCAPE_LINK =
  "u-pressable inline-flex min-h-11 items-center border border-rule px-5 font-mono text-[11.5px] tracking-[0.09em] text-ink uppercase hover:border-ink-secondary";

/**
 * Query-level failure. The state a student sees is chosen by what they can do
 * about it, not by which of the 21 error codes arrived: see
 * lib/query-error-state.ts. Only a genuine fault is styled as one, and the
 * retry button appears only where a second request could answer differently.
 *
 * `children` overrides the default way out, so a page that knows a better
 * destination than the mapping does keeps supplying it.
 */
export function QueryError({
  error,
  retry,
  children,
}: {
  error: unknown;
  retry?: () => void;
  children?: ReactNode;
}) {
  const state = queryErrorState(error);
  // The caller's link is more specific than ours (a run belongs to the
  // dashboard, not to the front page), so it wins when present.
  const wayOut = children ?? (
    state.link && (
      <Link
        to={state.link.to}
        className={
          state.presentation === "empty"
            ? ESCAPE_LINK
            : "text-[13px] text-ink underline underline-offset-4"
        }
      >
        {state.link.text}
      </Link>
    )
  );

  if (state.presentation === "empty") {
    return (
      // EmptyState carries no border of its own; every other caller wraps it
      // in this exact frame.
      <div
        role={state.role}
        aria-live="polite"
        className="border border-rule bg-paper-raised"
      >
        <EmptyState message={state.message}>{wayOut}</EmptyState>
      </div>
    );
  }

  const showRetry = Boolean(retry) && state.retry;

  return (
    <Panel tone={state.tone} label={state.label ?? undefined}>
      {/* The mark this replaces (LoadingMark) is a live region, so without
          one here a query flipping from pending to error announces nothing.
          role="status" carries an implicit polite live region; aria-live is
          repeated the way RunConsole.tsx:261 repeats it, since some screen
          readers miss a live region that is inserted rather than updated. */}
      <div
        role={state.role}
        aria-live={state.role === "status" ? "polite" : undefined}
      >
        <p className="max-w-prose text-[14px] text-ink">{state.message}</p>
        {state.nextStep && (
          <p className="mt-2 max-w-prose text-[12.5px] text-ink-faint">
            {state.nextStep}
          </p>
        )}
      </div>
      {(showRetry || wayOut) && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {showRetry && (
            <Button variant="ghost" onClick={retry}>
              Try again
            </Button>
          )}
          {wayOut}
        </div>
      )}
    </Panel>
  );
}
