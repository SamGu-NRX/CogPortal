import { Link } from "react-router";
import type { RunSummary } from "@cogworks/contracts/schema";
import { FAILURE_CATALOG } from "@cogworks/contracts/failures";
import { formatMetricValue, formatTimeAgo, runNumberLabel } from "@/lib/format";
import { runTitle } from "@/lib/run-meta";
import { StatusChip } from "./StatusChip";
import { Veil } from "./Veil";

/** Rows shown before the rest fold under a Veil. A week of steady work is
 *  about this many hosted runs, and the newest are the ones a team reopens. */
const SHOWN = 8;

/**
 * The team's run log for one benchmark, newest first: one row per run, each
 * opening the run. A row leads with what kind of run it was and which branch
 * (`runTitle`); the `Run #XXXX` tag and the commit sit under it as the record.
 *
 * A team with no runs gets nothing here, not a placeholder: the dashboard
 * shows its first-run sheet instead, and the one thing to do about an empty
 * log is the button there.
 */
export function RunList({
  runs,
  connectedFullName,
  publishedRunId,
}: {
  runs: RunSummary[];
  /** The repository the team is connected to now. A row names its own only
   *  when that differs, or is unrecorded: naming it on every row would repeat
   *  the page's own record, and the rows that matter are the ones a reader
   *  would otherwise attribute to the wrong repository. */
  connectedFullName?: string;
  /** The run the team has on the leaderboard, marked in its row. */
  publishedRunId?: string;
}) {
  if (runs.length === 0) return null;

  // When every scored run reports the same measure, the column says once
  // what the number is. A partial result can lead with a different one (a
  // Language run with no overall reports its text MRR), and then the column
  // is a plain "Reading" and each row names its own measure.
  const measures = new Set(runs.flatMap((run) => (run.primaryMetric ? [run.primaryMetric.key] : [])));
  const mixed = measures.size > 1;
  const metricLabel = mixed ? "Reading" : runs.find((run) => run.primaryMetric)?.primaryMetric?.label ?? "Reading";
  const row = (run: RunSummary) => (
    <RunRow
      key={run.id}
      run={run}
      connectedFullName={connectedFullName}
      published={run.id === publishedRunId}
      metricLabel={metricLabel}
      namesMeasure={mixed}
    />
  );

  return (
    <div>
      {/* Column heads for the wide layout only. Each row also says what its
          number is to a screen reader, so these are presentation. */}
      <div
        aria-hidden="true"
        className="hidden border-b border-rule pb-2 sm:grid sm:grid-cols-[minmax(0,1fr)_7.5rem_8.5rem_5.5rem] sm:gap-x-4"
      >
        <span className="u-kicker">Run</span>
        <span className="u-kicker">Status</span>
        <span className="u-kicker text-right">{metricLabel}</span>
        <span className="u-kicker text-right">Started</span>
      </div>
      <ul className="divide-y divide-rule-soft border-b border-rule-soft">
        {runs.slice(0, SHOWN).map(row)}
      </ul>
      {runs.length > SHOWN && (
        <Veil
          count={runs.length - SHOWN}
          peek={56}
          moreLabel={`Show ${runs.length - SHOWN} earlier ${runs.length - SHOWN === 1 ? "run" : "runs"}`}
          fewerLabel="Hide earlier runs"
          focusSelector="a"
        >
          <ul className="divide-y divide-rule-soft">{runs.slice(SHOWN).map(row)}</ul>
        </Veil>
      )}
    </div>
  );
}

function RunRow({
  run,
  connectedFullName,
  published,
  metricLabel,
  namesMeasure,
}: {
  run: RunSummary;
  connectedFullName?: string;
  published: boolean;
  metricLabel: string;
  /** The history mixes measures, so this row says which one its number is. */
  namesMeasure: boolean;
}) {
  // Empty for a run still moving: the status in the same row already says
  // where it is, and a dash in the reading column reads as a result that came
  // back blank.
  const reading = run.primaryMetric
    ? formatMetricValue(run.primaryMetric)
    : run.failure
      ? FAILURE_CATALOG[run.failure.category].code
      : "";
  const otherSource = !run.repo || run.repo.fullName !== connectedFullName;

  return (
    <li>
      {/* Phone: title and reading on the first line, status and age on the
          last. From sm the same four cells become columns. */}
      <Link
        to={`/runs/${run.id}`}
        className="group -mx-2 grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1.5 rounded-control px-2 py-3 transition-colors duration-150 hover:bg-ink/[0.03] sm:grid-cols-[minmax(0,1fr)_7.5rem_8.5rem_5.5rem]"
      >
        <span className="col-start-1 row-start-1 min-w-0">
          <span
            className="block text-[15px] font-semibold text-ink decoration-rule-strong underline-offset-[3px] group-hover:underline"
          >
            {runTitle(run)}
          </span>
          <span className="mt-0.5 block font-mono text-[12.5px] break-words text-ink-faint">
            {runNumberLabel(run.id)} · {run.shortSha}
            {otherSource && (
              // Same weight as the rest of the line. A renamed repository
              // keeps its old name here and is still the same repository, so
              // this names the source rather than warning about it;
              // eligibility is decided on the id, not this.
              <> · {run.repo ? run.repo.fullName : "source not recorded"}</>
            )}
            {published && <span className="text-verify-deep"> · on the leaderboard</span>}
          </span>
        </span>
        <StatusChip
          status={run.status}
          className="col-start-1 row-start-2 sm:col-start-auto sm:row-start-auto"
        />
        <span
          className={`u-tnum col-start-2 row-start-1 text-right font-mono text-[13.5px] sm:col-start-auto sm:row-start-auto ${
            run.failure ? "text-detect-deep" : "font-semibold text-ink"
          }`}
        >
          {reading && (
            <span className="sr-only">
              {run.failure ? "Failure code" : run.primaryMetric?.label ?? metricLabel}{" "}
            </span>
          )}
          {reading}
          {namesMeasure && run.primaryMetric && (
            <span aria-hidden="true" className="mt-0.5 block font-sans text-[12px] font-normal text-ink-faint">
              {run.primaryMetric.label}
            </span>
          )}
        </span>
        <span className="col-start-2 row-start-2 text-right text-[13px] whitespace-nowrap text-ink-faint sm:col-start-auto sm:row-start-auto">
          {formatTimeAgo(run.createdAt)}
        </span>
      </Link>
    </li>
  );
}
