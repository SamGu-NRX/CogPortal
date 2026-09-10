import { useState } from "react";
import { Link } from "react-router";
import { OFFICIAL_LIMIT } from "@cogworks/contracts/schema";
import { Button } from "@/components/Button";
import { Code } from "@/components/Code";
import { ConfirmButton } from "@/components/ConfirmButton";
import { EmptyState } from "@/components/EmptyState";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { Panel } from "@/components/Panel";
import { PhaseRail } from "@/components/PhaseRail";
import { QuotaCells } from "@/components/QuotaCells";
import { RunList } from "@/components/RunList";
import { SetupNudge } from "@/components/SetupNudge";
import { ShaChip } from "@/components/ShaChip";
import { SimulatedChip } from "@/components/SimulatedChip";
import { StatusChip } from "@/components/StatusChip";
import { TrackSwitcher } from "@/components/TrackSwitcher";
import { ApiRequestError } from "@/lib/api";
import {
  firstName,
  formatMetricValue,
  formatTimeAgo,
  greeting,
  runNumberLabel,
} from "@/lib/format";
import {
  useDashboard,
  useLocalReports,
  usePromote,
  useRepositories,
  useSession,
  useStartPractice,
} from "@/lib/queries";
import { STATUS_LABELS } from "@/lib/run-meta";
import { useTrack } from "@/lib/track";

/**
 * The team dashboard answers, at a glance (plan §8): what's connected, what
 * SHA was last tested, which benchmark version is active, what the current
 * run is doing, what failed and what to do, what budget remains, and what is
 * currently public.
 */
export function DashboardPage() {
  const track = useTrack();
  const dashboard = useDashboard(track.benchmarkId, !track.isPending);
  const repositories = useRepositories();
  const localReports = useLocalReports(track.benchmarkId);
  const { data: session } = useSession();

  if (track.isPending || dashboard.isPending) return <LoadingMark label="Loading" />;
  if (dashboard.isError) {
    return (
      <QueryError error={dashboard.error} retry={() => void dashboard.refetch()}>
        <Link to="/" className="text-[13px] text-ink underline underline-offset-4">
          Back to start
        </Link>
      </QueryError>
    );
  }

  const d = dashboard.data;
  const practiceLeft = d.quota.practiceLimit - d.quota.practiceUsed;
  const officialLeft = d.quota.officialLimit - d.quota.officialUsed;
  const branches =
    repositories.data?.find((r) => r.fullName === d.team.repo?.fullName)
      ?.branches ??
    (d.team.repo ? [d.team.repo.defaultBranch] : []);
  // A team with no runs gets a different page, not this one with empty frames
  // in it. Every standing-state panel here reports something a run produced,
  // so before the first run each would be a label over nothing, and the one
  // thing to do would be spread across five of them.
  const firstRun = d.runs.length === 0;
  // Only the segments this session can name. A team whose repository has not
  // resolved loses that segment rather than gaining a placeholder for it.
  const machine = [
    d.team.repo?.fullName,
    d.benchmark.runtimeVersion,
    "CPU",
    "network blocked during evaluation",
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const reports = localReports.data ?? [];

  return (
    <div className="anim-rise py-12">
      {/* ── Masthead ── */}
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <p className="u-kicker">
            {session?.user
              ? `${greeting(new Date().getHours())}, ${firstName(session.user.name, session.user.login)}`
              : "Team dashboard"}
          </p>
          <h1 className="mt-1 text-3xl">
            <Link to="/team" className="hover:underline hover:decoration-rule hover:underline-offset-8">
              {d.team.name}
            </Link>
          </h1>
        </div>
        <TrackSwitcher
          tracks={track.tracks}
          benchmark={track.benchmark ?? d.benchmark}
          onSelect={track.select}
          trailing={session?.auth.executionProvider === "fixture" ? <SimulatedChip /> : undefined}
        />
      </header>

      <SetupNudge />

      {firstRun ? (
        <div className="mt-8">
          <CurrentRunPanel
            dashboard={d}
            branches={branches}
            practiceLeft={practiceLeft}
            officialLeft={officialLeft}
            firstRun
          />
          <p className="mt-3 font-mono text-[11px] text-ink-faint">{machine}</p>
        </div>
      ) : (
        <>
      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        {/* ── Left column: the live instrument ── */}
        <div className="space-y-4 lg:col-span-2">
          <CurrentRunPanel
            dashboard={d}
            branches={branches}
            practiceLeft={practiceLeft}
            officialLeft={officialLeft}
          />

          {/* Rises on the poll that first returns a row, so the log arrives
              rather than appearing already there. */}
          <Panel
            className="anim-rise"
            label="RUN LOG"
            aside={
              <span className="u-tnum font-mono text-[11px] text-ink-faint">
                {d.runs.length} recorded
              </span>
            }
          >
            <RunList runs={d.runs} />
          </Panel>
        </div>

        {/* ── Right column: standing state ── */}
        <div className="space-y-4">
          <Panel label="CONNECTED SOURCE">
            {d.team.repo ? (
              <div className="space-y-2.5">
                <a
                  href={d.team.repo.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[13px] text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
                >
                  {d.team.repo.fullName}
                </a>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-mono text-[10.5px] tracking-[0.07em] text-ink-faint uppercase">
                    last tested
                  </span>
                  {d.lastResolvedSha ? (
                    <ShaChip sha={d.lastResolvedSha} shortSha={d.lastResolvedSha.slice(0, 7)} />
                  ) : (
                    <span className="font-mono text-[12px] text-ink-faint">
                      nothing yet; start a practice run
                    </span>
                  )}
                </div>
                <p className="border-t border-rule-soft pt-2.5 font-mono text-[11px] text-ink-faint">
                  {d.benchmark.runtimeVersion} · CPU · network blocked during evaluation
                </p>
              </div>
            ) : (
              <EmptyState message="No repository connected." />
            )}
          </Panel>

          {/* Cells count what has been spent, so before anything is spent the
              panel is ten empty boxes and a label. */}
          {(d.quota.practiceUsed > 0 || d.quota.officialUsed > 0) && (
            <Panel label="ATTEMPT BUDGET">
              <div className="space-y-5">
                <QuotaCells
                  used={d.quota.practiceUsed}
                  limit={d.quota.practiceLimit}
                  label="Hosted practice"
                />
                <QuotaCells
                  used={d.quota.officialUsed}
                  limit={d.quota.officialLimit}
                  label="Official attempts"
                  tone="detect"
                />
                {/* What the cells do, which is not what the `consumed` flag
                    does. `officialUsed` is the number of claim rows
                    (routes/dashboard.ts), and a claim row is written when the
                    run starts (services/run-actions.ts), so a cell fills on
                    promotion. `consumed` is written and never read. An attempt
                    returns when execution/refunds.ts deletes the claim, which
                    it does for a platform-side failure up to a cap. */}
                <p className="border-t border-rule-soft pt-3 text-[12px] leading-[1.55] text-ink-secondary">
                  Local runs are unlimited and are not counted here. An official
                  cell fills the moment you start that attempt, and it comes back
                  if the run fails for a reason on our side.
                </p>
              </div>
            </Panel>
          )}

          {d.selection && (
            <Panel label="PUBLISHED RESULT" tone="good">
              {/* Which run is public leads; its number is the reading under
                  it. A team ranks itself against a headline figure and does
                  not against an identifier, and the run is what they would
                  open next anyway. */}
              <p className="font-mono text-[13px] text-ink">
                {d.selection.attemptNumber
                  ? `attempt #${d.selection.attemptNumber} · `
                  : ""}
                {d.selection.shortSha}
              </p>
              <p className="u-tnum mt-1 font-mono text-[11.5px] tracking-[0.05em] text-ink-secondary">
                {d.selection.primaryMetric.label}{" "}
                {formatMetricValue(d.selection.primaryMetric)}
              </p>
              <div className="mt-3 flex items-center gap-4">
                <Link
                  to={`/runs/${d.selection.runId}`}
                  className="font-mono text-[11.5px] tracking-[0.06em] text-ink uppercase underline decoration-rule underline-offset-4 hover:decoration-ink"
                >
                  View run
                </Link>
                <Link
                  to="/leaderboard"
                  className="font-mono text-[11.5px] tracking-[0.06em] text-ink uppercase underline decoration-rule underline-offset-4 hover:decoration-ink"
                >
                  Leaderboard
                </Link>
              </div>
            </Panel>
          )}
        </div>
      </div>

        </>
      )}

      {/* Nothing while the query is in flight, so the panel does not appear
          and then withdraw. A failed query still renders: that a self-reported
          number could not be read is a fact about this session. */}
      {(reports.length > 0 || localReports.isError) && (
        <Panel
          label="LOCAL REPORTS"
          className="mt-4"
          aside={<span className="font-mono text-[10.5px] text-ink-faint">SELF-REPORTED · NOT PROMOTABLE</span>}
        >
          {localReports.isError ? (
            <p role="status" className="text-[13px] text-ink-secondary">
              Synced local reports are temporarily unavailable. Hosted and official results are unaffected.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-[13px]">
                <caption className="sr-only">Self-reported local CogBench results</caption>
                <thead className="border-b border-rule font-mono text-[10.5px] text-ink-faint">
                  <tr>
                    <th scope="col" className="pb-2 font-medium">Student</th>
                    <th scope="col" className="pb-2 font-medium">Commit</th>
                    <th scope="col" className="pb-2 font-medium">Result</th>
                    <th scope="col" className="pb-2 text-right font-medium">Synced</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule-soft">
                  {reports.slice(0, 5).map((report) => {
                    const primary = report.metrics.find((metric) => metric.primary);
                    return (
                      <tr key={report.reportId}>
                        <td className="py-2.5 font-mono text-ink">{report.author.login}</td>
                        <td className="py-2.5 font-mono text-ink-secondary">
                          {report.sha ? report.sha.slice(0, 7) : "not recorded"}
                          {report.dirty ? " · dirty" : ""}
                        </td>
                        <td className="py-2.5 text-ink">
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
              {reports.length > 5 && (
                <p className="mt-2 font-mono text-[10.5px] text-ink-faint">
                  showing the 5 newest of {reports.length} synced reports
                </p>
              )}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

/* ── Current run / launch controls ─────────────────────────────────────── */

function CurrentRunPanel({
  dashboard: d,
  branches,
  practiceLeft,
  officialLeft,
  firstRun = false,
}: {
  dashboard: import("@cogworks/contracts/schema").Dashboard;
  branches: string[];
  practiceLeft: number;
  officialLeft: number;
  /** The team has never run. There is no candidate to promote and no history
   *  to sit beside, so the panel carries both ways to run instead. */
  firstRun?: boolean;
}) {
  // The dashboard payload is already scoped to the selected track, so its own
  // benchmark id is the one to run; anything else would start a run the
  // student isn't looking at.
  const startPractice = useStartPractice(d.benchmark.id);
  const promote = usePromote();
  const [branch, setBranch] = useState(d.team.repo?.defaultBranch ?? "main");

  const active = d.activeRun;

  if (active) {
    return (
      // Rises in place of FIRST RUN on the poll that first sees the run, so
      // the swap reads as the panel changing rather than as a page reload.
      <Panel
        className="anim-rise"
        label="CURRENT RUN"
        aside={<StatusChip status={active.status} />}
      >
        {/* Status changes announce themselves; polling is invisible. */}
        <div aria-live="polite" className="sr-only">
          {runNumberLabel(active.id)} is {STATUS_LABELS[active.status].toLowerCase()}
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Link
            to={`/runs/${active.id}`}
            className="font-serif text-xl font-semibold text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
          >
            {runNumberLabel(active.id)}
          </Link>
          <span className="font-mono text-[11.5px] text-ink-faint">
            {active.mode === "official"
              ? `official attempt #${active.attemptNumber ?? "?"} · logs suppressed`
              : `practice · ${active.branch} · ${active.shortSha}`}
          </span>
        </div>
        <div className="mt-5">
          <PhaseRail status={active.status} failure={active.failure} />
        </div>
        <p className="mt-5 border-t border-rule-soft pt-3 font-mono text-[11px] text-ink-faint">
          Updates every 2 s · started {formatTimeAgo(active.createdAt)}
        </p>
      </Panel>
    );
  }

  const startError =
    startPractice.error instanceof ApiRequestError ? startPractice.error : null;
  const promoteError =
    promote.error instanceof ApiRequestError ? promote.error : null;
  const practiceExhausted = practiceLeft <= 0;

  const launcher = practiceExhausted ? (
    <p className="text-[14px] text-ink">
      All {d.quota.practiceLimit} hosted practice runs are used. Local practice
      stays unlimited.
    </p>
  ) : (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-44 flex-1">
        <label htmlFor="branch" className="u-kicker block">
          Branch
        </label>
        <select
          id="branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          className="mt-2 h-11 w-full border border-rule bg-paper-sunken px-2.5 font-mono text-[13px] text-ink"
        >
          {branches.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <Button
        onClick={() => startPractice.mutate(branch)}
        busy={startPractice.isPending}
      >
        Run practice benchmark
      </Button>
    </div>
  );

  const startFailed = startError && (
    <p role="alert" className="mt-3 text-[13px] text-detect-deep">
      {startError.code === "active_run_exists"
        ? "A run is already in progress; runs go one at a time per benchmark."
        : startError.message}
    </p>
  );

  if (firstRun) {
    return (
      <Panel label="FIRST RUN">
        {/* A team that has never run has no history to read the two kinds of
            run off, and the difference is the thing that decides which one
            they should be using today. The counts come from the dashboard
            payload, so they are this team's real remaining budget. */}
        <p className="max-w-[58ch] text-[13.5px] leading-[1.6] text-ink-secondary">
          There are two ways to run {d.benchmark.title}, and they score the same
          way. Start on your own machine, where nothing is counted, and spend a
          hosted run once a local score looks worth publishing.
        </p>

        <div className="mt-5 grid gap-6 sm:grid-cols-2">
          <div>
            <h3 className="u-kicker">On your machine</h3>
            <p className="mt-2 text-[13px] leading-[1.55] text-ink-secondary">
              Unlimited, and the same scorer. This is where the work happens.
            </p>
            {/* The commands carry this benchmark's id, so they are the ones to
                run rather than an example of the shape. */}
            <div className="mt-3">
              <Code
                lang="bash"
                code={
                  `cogworks check --benchmark ${d.benchmark.id}\n` +
                  `cogworks run --benchmark ${d.benchmark.id}\n` +
                  `cogworks sync`
                }
              />
            </div>
          </div>

          <div>
            <h3 className="u-kicker">Here, from your pushed commit</h3>
            <p className="mt-2 text-[13px] leading-[1.55] text-ink-secondary">
              {practiceLeft} of {d.quota.practiceLimit} hosted practice runs left,
              and {officialLeft} of {d.quota.officialLimit} official attempts. An
              official attempt is the one that uses the hidden set.
            </p>
            <div className="mt-3">{launcher}</div>
          </div>
        </div>
        {startFailed}
      </Panel>
    );
  }

  return (
    <Panel label="START A RUN">
      {/* Practice launch */}
      {launcher}
      {!practiceExhausted && (
        <p className="mt-3 font-mono text-[11px] text-ink-faint">
          {practiceLeft} of {d.quota.practiceLimit} hosted runs left
        </p>
      )}
      {startError && (
        <p role="alert" className="mt-3 text-[13px] text-detect-deep">
          {startError.code === "active_run_exists"
            ? "A run is already in progress; runs go one at a time per benchmark."
            : startError.message}
        </p>
      )}

      {/* Promotion */}
      {d.latestCandidate?.primaryMetric && (
        <div className="mt-6 border-t border-rule pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="u-kicker text-verify-deep">Candidate ready</div>
              <p className="mt-1 text-[14px]">
                <Link
                  to={`/runs/${d.latestCandidate.id}`}
                  className="font-medium underline decoration-rule underline-offset-4 hover:decoration-ink"
                >
                  {runNumberLabel(d.latestCandidate.id)}
                </Link>{" "}
                scored{" "}
                <span className="u-tnum font-mono font-medium">
                  {formatMetricValue(d.latestCandidate.primaryMetric)}
                </span>{" "}
                on {d.latestCandidate.branch} · {d.latestCandidate.shortSha}
              </p>
            </div>
            <ConfirmButton
              label="Promote to official"
              confirmLabel={`Confirm, uses attempt ${d.quota.officialUsed + 1} of ${OFFICIAL_LIMIT}`}
              onConfirm={() => promote.mutate(d.latestCandidate!.id)}
              busy={promote.isPending}
              disabled={officialLeft <= 0}
            />
          </div>
          <p className="mt-2 font-mono text-[11px] leading-relaxed text-ink-faint">
            {officialLeft <= 0
              ? "All official attempts are used."
              : "Runs the same commit against hidden inputs. Logs are suppressed."}
          </p>
          {promoteError && (
            <p role="alert" className="mt-2 text-[13px] text-detect-deep">
              {promoteError.message}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
