import type { LocalReport } from "@cogworks/contracts/schema";
import { formatMetricValue, formatTimeAgo } from "@/lib/format";

const SHOWN = 5;

/**
 * The newest synced local reports for one benchmark.
 *
 * `cogworks test` and `cogworks run` both save a report and either can be
 * synced, but they score different case sets, so a row's number means nothing
 * without the command that produced it. A report from before the CLI recorded
 * the command says so rather than borrowing either label.
 */
export function LocalReportsTable({ reports }: { reports: LocalReport[] }) {
  const shown = reports.slice(0, SHOWN);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-[13px]">
        <caption className="sr-only">Self-reported local CogBench results</caption>
        <thead className="border-b border-rule font-mono text-[10.5px] text-ink-faint">
          <tr>
            <th scope="col" className="pb-2 font-medium">Student</th>
            <th scope="col" className="pb-2 font-medium">Commit</th>
            <th scope="col" className="pb-2 font-medium">Command</th>
            <th scope="col" className="pb-2 font-medium">Result</th>
            <th scope="col" className="pb-2 text-right font-medium">Synced</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule-soft">
          {shown.map((report) => {
            const primary = report.metrics.find((metric) => metric.primary);
            return (
              <tr key={report.reportId}>
                <td className="py-2.5 font-mono text-ink">{report.author.login}</td>
                <td className="py-2.5 font-mono text-ink-secondary">
                  {report.sha ? report.sha.slice(0, 7) : "not recorded"}
                  {report.dirty ? " · dirty" : ""}
                </td>
                <td className={`py-2.5 font-mono ${report.command ? "text-ink-secondary" : "text-ink-faint"}`}>
                  {report.command ?? "not recorded"}
                </td>
                {/* A smoke-test number covers only the small cases, so it sits
                    one step lighter than a run's. The label and the note below
                    carry the meaning; ink-faint would fail AA contrast. */}
                <td className={`py-2.5 ${report.command === "test" ? "text-ink-secondary" : "text-ink"}`}>
                  {primary ? formatMetricValue(primary) : "no primary metric"}
                </td>
                <td className="py-2.5 text-right text-ink-faint">
                  {formatTimeAgo(report.syncedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {shown.some((report) => report.command === "test") && (
        <p className="mt-3 text-[12.5px] text-ink-secondary">
          A <code className="font-mono text-[12px]">test</code> row scored only the small
          smoke-test cases;{" "}
          <code className="font-mono text-[12px]">cogworks run</code> scores the practice set.
        </p>
      )}
      {reports.length > SHOWN && (
        <p className="mt-2 font-mono text-[10.5px] text-ink-faint">
          showing the {SHOWN} newest of {reports.length} synced reports
        </p>
      )}
    </div>
  );
}
