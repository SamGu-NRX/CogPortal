import type { ReactNode } from "react";
import { Link } from "react-router";
import { queryErrorState } from "@/lib/query-error-state";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { Panel } from "./Panel";

/** Quiet loading mark — content arrives with a 200ms rise, no spinners. */
export function LoadingMark({ label = "Loading" }: { label?: string }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-16 font-mono text-[11px] tracking-[0.09em] text-ink-faint uppercase"
    >
      <span aria-hidden="true" className="anim-live size-[7px] bg-detect" />
      {label}…
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
