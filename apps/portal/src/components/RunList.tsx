import { Link } from "react-router";
import type { RunSummary } from "@cogworks/contracts/schema";
import { FAILURE_CATALOG } from "@cogworks/contracts/failures";
import { formatMetricValue, formatTimeAgo, runNumberLabel } from "@/lib/format";
import { StatusChip } from "./StatusChip";

/**
 * The team's run record, newest first; every row answers "what happened and
 * where do I look". Semantic table on wide screens, labeled stacked records
 * on narrow ones (plan §8).
 *
 * A team with no runs gets nothing here, not a placeholder: the dashboard
 * withholds the whole RUN LOG panel until there is a row, and the one thing to
 * do about an empty log is the button in FIRST RUN.
 */
export function RunList({
  runs,
  connectedFullName,
}: {
  runs: RunSummary[];
  /** The repository the team is connected to now. A row names its own only
   *  when that differs, or is unrecorded: naming it on every row would repeat
   *  what the panel above already says, and the rows that matter are the ones
   *  a reader would otherwise attribute to the wrong repository. */
  connectedFullName?: string;
}) {
  if (runs.length === 0) return null;

  return (
    <ul className="divide-y divide-rule-soft">
      {runs.map((run) => {
        // Empty for a run still moving: the status chip in the same row already
        // says where it is, and a dash in the outcome column reads as a result
        // that came back blank.
        const outcome = run.primaryMetric
          ? formatMetricValue(run.primaryMetric)
          : run.failure
            ? FAILURE_CATALOG[run.failure.category].code
            : "";
        return (
          <li key={run.id}>
            <Link
              to={`/runs/${run.id}`}
              className="group grid min-h-14 grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 py-2.5 transition-colors duration-150 hover:bg-paper-sunken/60 sm:grid-cols-[92px_88px_1fr_auto_auto] sm:gap-x-5"
            >
              <span className="font-mono text-[12px] font-medium text-ink group-hover:underline group-hover:decoration-rule group-hover:underline-offset-4">
                {runNumberLabel(run.id)}
              </span>
              <span
                className={`font-mono text-[10.5px] tracking-[0.09em] uppercase ${
                  run.mode === "official" ? "text-detect-deep font-medium" : "text-ink-faint"
                }`}
              >
                {run.mode === "official"
                  ? `official ${run.attemptNumber ? `#${run.attemptNumber}` : ""}`
                  : "practice"}
              </span>
              <span className="col-span-2 flex items-center gap-3 sm:col-span-1">
                <StatusChip status={run.status} />
                <span className="font-mono text-[11px] text-ink-faint">
                  {run.branch} · {run.shortSha}
                  {(!run.repo || run.repo.fullName !== connectedFullName) && (
                    // Same weight as the rest of the line. A renamed
                    // repository keeps its old name here and is still the same
                    // repository, so this names the source rather than warning
                    // about it; eligibility is decided on the id, not this.
                    <span>
                      {" "}
                      · {run.repo ? run.repo.fullName : "source not recorded"}
                    </span>
                  )}
                </span>
              </span>
              <span
                className={`u-tnum text-right font-mono text-[12.5px] ${
                  run.failure ? "text-detect-deep" : "font-medium text-ink"
                }`}
              >
                {outcome}
              </span>
              <span className="hidden text-right font-mono text-[11px] text-ink-faint sm:block">
                {formatTimeAgo(run.createdAt)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
