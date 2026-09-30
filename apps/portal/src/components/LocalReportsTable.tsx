import { type RefObject, useEffect, useId, useRef, useState } from "react";
import type { Benchmark, LocalReport } from "@cogworks/contracts/schema";
import { formatMetricValue, formatTimeAgo } from "@/lib/format";

const SHOWN = 5;

/**
 * The newest synced local reports, for one track or for the benchmarks that
 * have none.
 *
 * `cogworks test` and `cogworks run` both save a report and either can be
 * synced, but they score different case sets, so a row's number means nothing
 * without the command that produced it. A report from before the CLI recorded
 * the command says so rather than borrowing either label.
 *
 * No author column: a name beside a score reads as that student's grade. The
 * result belongs to the commit.
 */
export function LocalReportsTable({
  reports,
  caption,
  catalog,
}: {
  reports: LocalReport[];
  caption: string;
  /** Pass the whole catalog, inactive rows included, to name each row's
   *  benchmark; a single track's table leaves it out. */
  catalog?: Benchmark[];
}) {
  const shown = reports.slice(0, SHOWN);
  const captionId = useId();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const overflows = useHorizontalOverflow(scrollerRef);
  return (
    <>
      {/* Scrolls inside the panel, not the page, when a long title or large
          text makes the row wider than a phone. Only then is it a tab stop
          (so a keyboard can scroll it) and a region named by the caption, so
          the stop announces what it holds; a table that fits takes neither. */}
      <div
        ref={scrollerRef}
        className="overflow-x-auto"
        tabIndex={overflows ? 0 : undefined}
        role={overflows ? "region" : undefined}
        aria-labelledby={overflows ? captionId : undefined}
      >
        <table className="w-full text-left text-[13px]">
          <caption id={captionId} className="sr-only">{caption}</caption>
          <thead className="border-b border-rule font-mono text-[10.5px] text-ink-faint">
            <tr>
              {catalog && <th scope="col" className="pr-3 pb-2 font-medium">Benchmark</th>}
              <th scope="col" className="pr-3 pb-2 font-medium">Commit</th>
              <th scope="col" className="pr-3 pb-2 font-medium">Command</th>
              <th scope="col" className="pr-3 pb-2 font-medium">Result</th>
              <th scope="col" className="pb-2 text-right font-medium">Synced</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule-soft">
            {shown.map((report) => {
              const primary = report.metrics.find((metric) => metric.primary);
              return (
                <tr key={report.reportId} className="align-baseline">
                  {catalog && (
                    <td className="py-2.5 pr-3 text-ink">
                      <BenchmarkName report={report} catalog={catalog} />
                    </td>
                  )}
                  <td className="py-2.5 pr-3 font-mono text-ink-secondary">
                    {report.sha ? report.sha.slice(0, 7) : "not recorded"}
                    {report.dirty && (
                      <>
                        {" "}
                        <span className="whitespace-nowrap">· dirty</span>
                      </>
                    )}
                  </td>
                  <td className={`py-2.5 pr-3 font-mono ${report.command ? "text-ink-secondary" : "text-ink-faint"}`}>
                    {report.command ?? "not recorded"}
                  </td>
                  {/* A smoke-test number covers only the small cases, so it
                      sits one step lighter than a run's. The label and the
                      note below carry the meaning. */}
                  <td className={`u-tnum py-2.5 pr-3 ${report.command === "test" ? "text-ink-secondary" : "text-ink"}`}>
                    {primary ? formatMetricValue(primary) : "no primary metric"}
                  </td>
                  <td className="py-2.5 text-right whitespace-nowrap text-ink-faint">
                    {formatTimeAgo(report.syncedAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
    </>
  );
}

/**
 * Whether the box is narrower than its content. Watches the table as well as
 * the box: a longer row or a late web font widens the table without resizing
 * the box.
 */
function useHorizontalOverflow(ref: RefObject<HTMLElement | null>): boolean {
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setOverflows(node.scrollWidth > node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [ref]);
  return overflows;
}

function BenchmarkName({ report, catalog }: { report: LocalReport; catalog: Benchmark[] }) {
  // The exact version's row first; a version the catalog doesn't carry still
  // belongs to a benchmark whose title we know.
  const title = (
    catalog.find((b) => b.id === report.benchmarkId && b.version === report.benchmarkVersion) ??
    catalog.find((b) => b.id === report.benchmarkId)
  )?.title;
  return (
    <>
      {title ?? <span className="font-mono [overflow-wrap:anywhere]">{report.benchmarkId}</span>}{" "}
      <span className="font-mono text-[11.5px] whitespace-nowrap text-ink-faint">
        v{report.benchmarkVersion}
      </span>
    </>
  );
}
