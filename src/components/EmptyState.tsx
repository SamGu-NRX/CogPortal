import type { ReactNode } from "react";
import { CornerBrackets } from "./Brackets";

/**
 * An empty slot on the instrument: brackets around waiting space. Empty
 * states always say what will appear here and how to make it happen.
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
      className={`relative flex flex-col items-center justify-center gap-3 px-6 py-10 text-center ${className}`}
    >
      <CornerBrackets size={14} thickness={1} inset={0} className="text-rule" />
      <p className="max-w-sm font-mono text-[12px] leading-relaxed tracking-[0.02em] text-ink-faint">
        {message}
      </p>
      {children}
    </div>
  );
}
