import type { ReactNode } from "react";
import { ApiRequestError } from "@/lib/api";
import { Button } from "./Button";
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

/**
 * Query-level failure — even infrastructure errors state what happened and
 * what to do next (plan §8: no dead ends).
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
  const message =
    error instanceof ApiRequestError
      ? error.message
      : "This view couldn't load. Try again.";
  return (
    <Panel tone="alert" label="COULD NOT LOAD">
      <p className="max-w-prose text-[14px] text-ink">{message}</p>
      <div className="mt-4 flex items-center gap-3">
        {retry && (
          <Button variant="ghost" onClick={retry}>
            Try again
          </Button>
        )}
        {children}
      </div>
    </Panel>
  );
}
