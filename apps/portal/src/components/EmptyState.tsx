import type { ReactNode } from "react";
import { CornerBrackets } from "./Brackets";

/**
 * An empty slot on the page: detection brackets around waiting space. An empty
 * state says what will appear here and how to make it happen, in one plain
 * sentence and no apology.
 */
export function EmptyState({
  message,
  children,
  className = "",
}: {
  message: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative flex flex-col items-center justify-center gap-4 px-6 py-10 text-center ${className}`}
    >
      <CornerBrackets size={14} thickness={1.25} inset={0} className="text-rule-strong" />
      <p className="max-w-[40ch] text-[14.5px] leading-[1.55] text-ink-secondary">{message}</p>
      {children}
    </div>
  );
}
