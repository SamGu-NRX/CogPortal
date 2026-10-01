import type { RunStatus } from "@cogworks/contracts/schema";
import { STATUS_LABELS, statusTone } from "@/lib/run-meta";

/**
 * Status is always text plus color, never color alone (plan §8). The square
 * dot pulses only while the instrument is actually measuring.
 */
export function StatusChip({
  status,
  className = "",
}: {
  status: RunStatus;
  className?: string;
}) {
  const tone = statusTone(status);
  const text = {
    live: "text-ink",
    good: "text-verify-deep",
    bad: "text-detect-deep",
    muted: "text-ink-secondary",
  }[tone];
  const dot = {
    live: "bg-detect anim-live",
    good: "bg-verify",
    bad: "bg-detect",
    muted: "bg-ink-faint",
  }[tone];

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[13px] font-semibold ${text} ${className}`}
    >
      <span aria-hidden="true" className={`size-2 rounded-[1.5px] ${dot}`} />
      {STATUS_LABELS[status]}
    </span>
  );
}
