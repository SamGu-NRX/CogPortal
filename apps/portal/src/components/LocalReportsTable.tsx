import { type RefObject, useEffect, useId, useRef, useState } from "react";
import type { Benchmark, LocalReport } from "@cogworks/contracts/schema";
import { Veil } from "@/components/Veil";
import { formatMetricValue, formatTimeAgo } from "@/lib/format";

const SHOWN = 5;

/**
 * Notes a row shows before the rest fold away. Three is a density choice for
 * a list of up to five reports: it keeps a row to about a short paragraph,
 * and the Week 3 reports seen so far carry one or two notes, so they show in
 * full. It says nothing about which notes matter; they stay in the order the
 * benchmark wrote them.
 */
const NOTES_SHOWN = 3;

/**
 * The newest synced local reports, for one track or for the benchmarks that
 * have none.
 *
 * A row leads with what the report says, the way the run page leads with its
 * finding: the benchmark's first note as the sentence, the next ones smaller
 * beneath it, and the score last as a footnote. A teammate reading 0.171 alone
 * can't tell which stage gave way; the notes are where the benchmark says. The
 * text is the report's own, shown as written. Nothing here is generated or reordered, and
 * the section's "Self-reported, not promotable" label covers every row.
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
  const identities = rowIdentities(shown, catalog);
  const captionId = useId();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const overflows = useHorizontalOverflow(scrollerRef);
  const [focused, setFocused] = useState(false);
  // Kept while focused: removing the stop under focus (a phone rotated to
  // landscape) sends the next Tab back to the top of the page.
  const stop = overflows || focused;
  return (
    <>
      {/* Scrolls inside the panel when a row is wider than a phone. Only
          then is it a focusable region named by the caption, so a keyboard
          can scroll it. */}
      <div
        ref={scrollerRef}
        className="overflow-x-auto"
        tabIndex={stop ? 0 : undefined}
        role={stop ? "region" : undefined}
        aria-labelledby={stop ? captionId : undefined}
        // Only the box's own focus counts. React's focus events bubble, so a
        // control inside a row (the notes fold) would otherwise turn a table
        // that fits into a tab stop of its own.
        onFocus={(event) => {
          if (event.target === event.currentTarget) setFocused(true);
        }}
        onBlur={(event) => {
          if (event.target === event.currentTarget) setFocused(false);
        }}
      >
        {/* Two columns rather than one per field, so the notes get a
            reading width on a phone instead of a sideways scroll. */}
        <table className="w-full text-left text-[14px]">
          <caption id={captionId} className="sr-only">{caption}</caption>
          <thead className="border-b border-rule">
            <tr>
              <th scope="col" className="u-kicker w-[5.75rem] pr-3 pb-2 align-bottom sm:w-[9rem] sm:pr-4">
                {catalog ? "Benchmark and commit" : "Commit"}
              </th>
              <th scope="col" className="u-kicker pb-2 align-bottom">What the report says</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule-soft">
            {shown.map((report) => (
              <tr key={report.reportId} className="align-top">
                <td className="py-3 pr-3 sm:pr-4">
                  {catalog && (
                    <p className="mb-1 text-[14px] leading-[1.35] text-ink">
                      <BenchmarkName report={report} catalog={catalog} />
                    </p>
                  )}
                  <p className="font-mono text-[13px] text-ink-secondary">
                    {report.sha ? report.sha.slice(0, 7) : "not recorded"}
                    {report.dirty && (
                      <>
                        {" "}
                        <span className="whitespace-nowrap">· dirty</span>
                      </>
                    )}
                  </p>
                  {/* The command as typed, so the row names it without a
                      column of its own; a report from before the CLI
                      recorded it says so rather than borrowing either. */}
                  <p
                    className={`mt-0.5 font-mono text-[12.5px] leading-[1.45] ${
                      report.command ? "text-ink-secondary" : "text-ink-faint"
                    }`}
                  >
                    {report.command ? `cogworks ${report.command}` : "command not recorded"}
                  </p>
                </td>
                <td className="py-3">
                  <ReportNotes report={report} identity={identities.get(report.reportId) ?? ""} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.some((report) => report.command === "test") && (
        <p className="mt-3 text-[13.5px] text-ink-secondary">
          A <code className="font-mono text-[13px]">test</code> row scored only the small
          smoke-test cases;{" "}
          <code className="font-mono text-[13px]">cogworks run</code> scores the practice set.
        </p>
      )}
      {reports.length > SHOWN && (
        <p className="mt-2 text-[13px] text-ink-faint">
          Showing the {SHOWN} newest of {reports.length} synced reports.
        </p>
      )}
    </>
  );
}

/**
 * One report's notes in the benchmark's order, then its score. The same
 * hierarchy as the run page's Finding, set small enough for a row: the first
 * note in the serif, the next two as hairline-marked lines, anything past
 * NOTES_SHOWN behind a Veil.
 */
function ReportNotes({ report, identity }: { report: LocalReport; identity: string }) {
  const [first, ...rest] = report.diagnostics;
  const supporting = rest.slice(0, NOTES_SHOWN - 1);
  const folded = rest.slice(NOTES_SHOWN - 1);
  const primary = report.metrics.find((metric) => metric.primary);
  return (
    <>
      {first === undefined ? (
        // Only that the notes are absent: an empty list is not a clean bill
        // of health, and the score below is all the report holds.
        <p className="text-[14px] text-ink-faint">This report has no notes.</p>
      ) : (
        <p className="font-serif text-[15.5px] leading-[1.4] font-[480] tracking-[-0.005em] text-ink [overflow-wrap:anywhere] sm:text-[16.5px]">
          {first}
        </p>
      )}
      {supporting.length > 0 && <NoteList notes={supporting} className="mt-2" />}
      {folded.length > 0 && (
        // No margin of its own: the Veil's region already opens with its
        // top padding, which matches the gap between the notes above.
        <div>
          <Veil
            count={folded.length}
            moreLabel={`See ${folded.length} more ${folded.length === 1 ? "note" : "notes"}`}
            fewerLabel="Show fewer notes"
            labelContext={`for ${identity}`}
          >
            <NoteList notes={folded} />
          </Veil>
        </div>
      )}
      {/* The score and the sync time as a footnote, under what the score
          measured. A smoke-test number covers only the small cases, so it
          sits one step lighter than a run's; the line below the table says
          why. */}
      <p className="u-tnum mt-2 font-mono text-[12.5px] text-ink-faint">
        {/* A metric's label and unit are the report's own strings, unbounded
            by the schema, so they may wrap anywhere like the notes. */}
        <span
          className={`[overflow-wrap:anywhere] ${report.command === "test" ? "text-ink-faint" : "text-ink-secondary"}`}
        >
          {primary ? `${primary.label} ${formatMetricValue(primary)}` : "no primary metric"}
        </span>
        {/* The dot stays with the score, so a narrow row breaks after it. */}
        {"\u00a0· "}
        <span className="whitespace-nowrap">synced {formatTimeAgo(report.syncedAt)}</span>
      </p>
    </>
  );
}

function NoteList({ notes, className = "" }: { notes: string[]; className?: string }) {
  return (
    <ul className={`space-y-1.5 ${className}`}>
      {notes.map((note, index) => (
        <li key={`${index}:${note}`} className="flex gap-2.5 text-[13.5px] leading-[1.5] text-ink-secondary">
          <span aria-hidden="true" className="mt-[0.72em] h-px w-2.5 shrink-0 bg-ink-faint" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{note}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Whether the box is narrower than its content. Watches the table too: a
 * longer row or a late web font widens it without resizing the box.
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

/**
 * How a screen reader tells one row's notes control from another's: "commit
 * c29e5b1 (cogworks run, synced 25 h ago)", with the benchmark first in the
 * catalog table. A commit can be synced more than once, so rows that would
 * still read alike get the end of their report id as well.
 */
function rowIdentities(reports: LocalReport[], catalog: Benchmark[] | undefined): Map<string, string> {
  const base = (report: LocalReport) => {
    const benchmark = catalog
      ? `${benchmarkTitle(report, catalog) ?? report.benchmarkId} v${report.benchmarkVersion}, `
      : "";
    const commit = report.sha ? `commit ${report.sha.slice(0, 7)}` : "no recorded commit";
    const command = report.command ? `cogworks ${report.command}` : "command not recorded";
    return `${benchmark}${commit} (${report.dirty ? "dirty, " : ""}${command}, synced ${formatTimeAgo(report.syncedAt)}`;
  };
  const counts = new Map<string, number>();
  for (const report of reports) counts.set(base(report), (counts.get(base(report)) ?? 0) + 1);
  return new Map(
    reports.map((report) => {
      const text = base(report);
      const repeated = (counts.get(text) ?? 0) > 1;
      return [report.reportId, `${text}${repeated ? `, report ${report.reportId.slice(-6)}` : ""})`];
    }),
  );
}

function benchmarkTitle(report: LocalReport, catalog: Benchmark[]): string | undefined {
  // The exact version's row first; a version the catalog doesn't carry still
  // belongs to a benchmark whose title we know.
  return (
    catalog.find((b) => b.id === report.benchmarkId && b.version === report.benchmarkVersion) ??
    catalog.find((b) => b.id === report.benchmarkId)
  )?.title;
}

function BenchmarkName({ report, catalog }: { report: LocalReport; catalog: Benchmark[] }) {
  const title = benchmarkTitle(report, catalog);
  return (
    <>
      {title ?? <span className="font-mono [overflow-wrap:anywhere]">{report.benchmarkId}</span>}{" "}
      <span className="font-mono text-[12.5px] whitespace-nowrap text-ink-faint">
        v{report.benchmarkVersion}
      </span>
    </>
  );
}
