import { Link, useNavigate, useParams } from "react-router";
import { ApiRequestError } from "@/lib/api";
import { FAILURE_CATALOG } from "@cogworks/contracts/failures";
import { OFFICIAL_LIMIT, isTerminal } from "@cogworks/contracts/schema";
import { Button } from "@/components/Button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { FailureCard } from "@/components/FailureCard";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { LogView } from "@/components/LogView";
import { RefusalCard } from "@/components/RefusalCard";
import { Finding } from "@/components/Finding";
import { PrimaryMetric, SupportingMetrics } from "@/components/MetricBlock";
import { SweepTrace } from "@/components/SweepTrace";
import { WiringTrace } from "@/components/WiringTrace";
import { Panel } from "@/components/Panel";
import { PhaseRail } from "@/components/PhaseRail";
import { ShaChip } from "@/components/ShaChip";
import { SimulatedChip } from "@/components/SimulatedChip";
import { StatusChip } from "@/components/StatusChip";
import {
  formatDateTime,
  formatDurationMs,
  runNumberLabel,
} from "@/lib/format";
import {
  DEFAULT_BENCHMARK,
  useBenchmarks,
  useDashboard,
  usePromote,
  useRun,
  useSelectResult,
  useSession,
  useStartPractice,
} from "@/lib/queries";
import { PHASE_LABELS, STATUS_LABELS } from "@/lib/run-meta";

/**
 * Run detail (plan §8): the phase rail, then exactly one of: live progress,
 * a failure with its corrective action, or results with the next meaningful
 * action (promote / publish). Practice runs show capped logs; official runs
 * show aggregate metrics and safe diagnostics only.
 */
export function RunDetailPage() {
  const { runId = "" } = useParams();
  const runQuery = useRun(runId);
  const { data: sessionData } = useSession();
  // Quota, retry, and failure copy all belong to *this run's* benchmark, not
  // to whichever track the dashboard happens to default to. The fallback only
  // covers the first render, before the run record arrives.
  const runBenchmarkId = runQuery.data?.benchmarkId ?? DEFAULT_BENCHMARK;
  const benchmarks = useBenchmarks();
  const runModule = benchmarks.data?.find((b) => b.id === runBenchmarkId)?.module;
  // Cached alongside the dashboard: supplies quota and selection context.
  const dashboard = useDashboard(runBenchmarkId, Boolean(runQuery.data));
  const promote = usePromote();
  const select = useSelectResult();
  const retry = useStartPractice(runBenchmarkId);
  const navigate = useNavigate();
  // A local run from a detached HEAD records no branch, and the page shows
  // "detached" for it. Passing that word to startPractice asked GitHub for
  // a ref called `detached`. Omitting the branch lets the server use the
  // team's default, which is the only branch it can resolve for that run.
  // And the run the retry starts is the one to look at, so go there: the
  // old page kept its button, and pressing it again returned
  // active_run_exists.
  const retryFrom = (branch: string | null) =>
    retry.mutate(branch && branch !== "detached" ? branch : undefined, {
      onSuccess: ({ runId: started }) => navigate(`/runs/${started}`),
    });

  if (runQuery.isPending) return <LoadingMark label="Reading run record" />;
  if (runQuery.isError) {
    return (
      <QueryError error={runQuery.error} retry={() => void runQuery.refetch()}>
        <Link
          to="/dashboard"
          className="text-[13px] text-ink underline underline-offset-4"
        >
          Back to dashboard
        </Link>
      </QueryError>
    );
  }

  const run = runQuery.data;
  const quota = dashboard.data?.quota;
  const live = !isTerminal(run.status);
  const failureCopy = run.failure ? FAILURE_CATALOG[run.failure.category] : null;
  const primary = run.metrics.find((m) => m.primary) ?? null;
  const supporting = run.metrics.filter((m) => !m.primary);
  const duration =
    run.finishedAt != null ? formatDurationMs(run.finishedAt - run.createdAt) : null;

  return (
    <div className="anim-rise mx-auto w-full max-w-4xl py-12">
      <Link
        to="/dashboard"
        className="font-mono text-[11px] tracking-[0.09em] text-ink-secondary uppercase hover:text-ink"
      >
        ← Dashboard
      </Link>

      {/* ── Masthead ── */}
      <header className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="font-serif text-3xl font-semibold">
          {runNumberLabel(run.id)}
        </h1>
        <span
          className={`border px-2 py-0.5 font-mono text-[10.5px] font-medium tracking-[0.09em] uppercase ${
            run.mode === "official"
              ? "border-detect text-detect-deep"
              : "border-rule text-ink-secondary"
          }`}
        >
          {run.mode === "official"
            ? `Official · attempt ${run.attemptNumber ?? "?"}/${OFFICIAL_LIMIT}`
            : "Practice"}
        </span>
        <StatusChip status={run.status} />
        {sessionData?.auth.executionProvider === "fixture" && <SimulatedChip />}
      </header>
      <div aria-live="polite" className="sr-only">
        Run status: {STATUS_LABELS[run.status]}
      </div>

      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[12px] text-ink-secondary">
        <span>
          {run.benchmarkId} / v{run.benchmarkVersion}
        </span>
        <span aria-hidden="true" className="text-rule">|</span>
        <span>{run.branch}</span>
        <ShaChip sha={run.sha} shortSha={run.shortSha} />
        <span aria-hidden="true" className="text-rule">|</span>
        <span>{formatDateTime(run.createdAt)}</span>
        {duration && (
          <>
            <span aria-hidden="true" className="text-rule">|</span>
            <span className="u-tnum">{duration}</span>
          </>
        )}
      </p>
      {run.weightsSupplied.length > 0 && (
        <p className="mt-2 break-words font-mono text-[11px] leading-relaxed text-ink-faint">
          {run.weightsSupplied.join(", ")} from your local run at {run.shortSha}
        </p>
      )}

      {/* ── Pipeline ── */}
      <Panel label="PIPELINE" className="mt-8">
        <PhaseRail
          status={run.status}
          failure={run.failure}
          phases={run.phases}
          showTimings
        />
        {live && (
          <p className="mt-5 border-t border-rule-soft pt-3 font-mono text-[11px] text-ink-faint">
            {run.mode === "official"
              ? "Hidden evaluation; logs are suppressed."
              : "Updates every 2 s."}
          </p>
        )}
      </Panel>

      {/* ── Failure ── */}
      {run.failure && failureCopy && (
        <div className="mt-4 space-y-4">
          {/* A refusal is written in the team's own function names and module
              names, and the failure card beside it is the same event in the
              generic. So the refusal leads and the card collapses to the three
              things it alone carries: which failure, which mode, what it cost.
              Every other failure has a traceback, keeps its full card, and
              sends the reader to the log. */}
          {run.refusal ? (
            <RefusalCard
              refusal={run.refusal}
              benchmarkId={run.benchmarkId}
              stage={PHASE_LABELS[run.failure.phase]}
              aside={
                <FailureCard
                  failure={run.failure}
                  mode={run.mode}
                  benchmarkId={run.benchmarkId}
                  module={runModule}
                  collapsed
                />
              }
            />
          ) : (
            <FailureCard
              failure={run.failure}
              mode={run.mode}
              benchmarkId={run.benchmarkId}
              module={runModule}
            />
          )}
          {run.mode === "practice" && failureCopy.retryable && (
            <Button
              variant="ghost"
              busy={retry.isPending}
              onClick={() => retryFrom(run.branch)}
            >
              Run practice again on {run.branch ?? "the default branch"}
            </Button>
          )}
          {/* A failed official run occupies its surface, so promoting the
              same candidate again is refused by the server every time. The
              real recovery is a fresh practice run: it opens a new surface
              whose success becomes the next promotable candidate. */}
          {run.mode === "official" && !run.failure.consumedAttempt && (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="ghost"
                busy={retry.isPending}
                onClick={() => retryFrom(run.branch)}
              >
                Run practice again on {run.branch ?? "the default branch"}
              </Button>
              <span className="font-mono text-[11px] text-ink-faint">
                attempt not consumed; a fresh practice run creates the next candidate to promote
              </span>
            </div>
          )}
          {retry.error && (
            <p role="alert" className="mt-3 text-[13px] text-detect-deep">
              {retry.error instanceof ApiRequestError
                ? retry.error.message
                : "The action couldn't be completed. Try again."}
            </p>
          )}
        </div>
      )}

      {/* ── Results ── */}
      {run.status === "succeeded" && primary && (
        <>
          {/* The finding leads. A team reading 0.53 with nothing else has to
              guess which half of their pipeline produced it, and the scorer
              already knows: its first diagnostic names the stage and the
              cause. The number is below, where a reading sits under the trace
              that explains it. */}
          {(run.diagnostics.length > 0 || run.sweep) && (
            <Panel className="mt-4">
              {run.diagnostics.length > 0 && (
                <Finding
                  sentence={run.diagnostics[0]}
                  supporting={run.diagnostics.slice(1)}
                />
              )}
              {run.sweep && (
                <div className={run.diagnostics.length > 0 ? "mt-5 border-t border-rule-soft pt-4" : ""}>
                  <SweepTrace sweep={run.sweep} />
                </div>
              )}
            </Panel>
          )}
          {/* Below the finding, above the number. Nothing in a 2026
              repository says which function is the peak finder, so the
              platform found theirs by running them; this says which ones it
              settled on. It sits here because a team checks it when a score
              surprises them, which is after they have read the finding and
              before they argue with the number. Absent for a repository that
              declared its own submission: nothing was inferred. */}
          {run.wiring.length > 0 && (
            <Panel className="mt-4">
              <WiringTrace steps={run.wiring} />
            </Panel>
          )}
          <Panel label="RESULTS" className="mt-4">
            <div className="grid items-start gap-6 sm:grid-cols-2">
              <PrimaryMetric metric={primary} />
              <SupportingMetrics metrics={supporting} />
            </div>
            {/* Kept for a run whose scorer had nothing to say, which is rare
                and would otherwise lose its notes entirely. */}
            {run.diagnostics.length === 0 && (
              <p className="mt-4 max-w-prose text-[13.5px] leading-relaxed text-ink-secondary">
                The scorer had no notes on this run.
              </p>
            )}
            <p className="mt-4 border-t border-rule-soft pt-3 font-mono text-[11px] text-ink-faint">
              {run.mode === "practice"
                ? "Public practice split."
                : "Hidden official split."}
            </p>
          </Panel>
        </>
      )}

      {/* ── Next action ── */}
      {run.status === "succeeded" && run.mode === "practice" && (
        <Panel label="PROMOTE" className="mt-4">
          <p className="max-w-prose text-[14px] text-ink-secondary">
            Re-runs <span className="font-mono text-[13px]">{run.shortSha}</span>{" "}
            against the hidden official inputs. Logs are suppressed.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <ConfirmButton
              label="Promote to official"
              confirmLabel={`Confirm, uses attempt ${(quota?.officialUsed ?? 0) + 1} of ${OFFICIAL_LIMIT}`}
              onConfirm={() =>
                promote.mutate(run.id, {
                  // The official run is the one to watch, and nothing on this
                  // page links to it. The retry path above navigates for the
                  // same reason.
                  onSuccess: ({ runId: started }) => navigate(`/runs/${started}`),
                })
              }
              busy={promote.isPending}
              disabled={!quota || quota.officialUsed >= quota.officialLimit}
            />
            {quota && (
              <span className="u-tnum font-mono text-[12px] text-ink-secondary">
                {Math.max(0, quota.officialLimit - quota.officialUsed)} official{" "}
                {quota.officialLimit - quota.officialUsed === 1
                  ? "attempt"
                  : "attempts"}{" "}
                remaining
              </span>
            )}
          </div>
          {quota && quota.officialUsed >= quota.officialLimit && (
            <p className="mt-3 text-[13px] text-detect-deep">
              All official attempts are used for this benchmark version. Your
              existing successful official runs can still be selected for the
              leaderboard.
            </p>
          )}
          {/* Here, under the button that failed. This used to sit in the
              failure block above, which renders only when run.failure is
              set, and promotion is offered only for a run that succeeded:
              the two never rendered together, so a refused promotion showed
              a button that stopped spinning and nothing else. */}
          {promote.error && (
            <p role="alert" className="mt-3 text-[13px] text-detect-deep">
              {promote.error instanceof ApiRequestError
                ? promote.error.message
                : "The promotion couldn't be started. Try again."}
            </p>
          )}
        </Panel>
      )}

      {run.status === "succeeded" && run.mode === "official" && (
        <Panel
          label={run.selected ? "PUBLISHED" : "PUBLISH"}
          tone={run.selected ? "good" : "default"}
          className="mt-4"
        >
          {run.selected ? (
            <p className="max-w-prose text-[14px] leading-relaxed text-ink">
              This result is your team's public entry.{" "}
              <Link
                to="/leaderboard"
                className="underline decoration-rule underline-offset-4 hover:decoration-ink"
              >
                See it on the leaderboard.
              </Link>
            </p>
          ) : (
            <>
              <p className="max-w-prose text-[14px] text-ink-secondary">
                You can switch to another successful official run at any time,
                at no cost.
              </p>
              <ConfirmButton
                variant="primary"
                className="mt-4"
                label="Publish to leaderboard"
                confirmLabel="Confirm, make this the public result"
                onConfirm={() => select.mutate(run.id)}
                busy={select.isPending}
              />
            </>
          )}
        </Panel>
      )}

      {/* ── Log (practice only) ── */}
      {run.mode === "practice" && run.log && (
        <Panel label="LOG · CAPPED" className="mt-4">
          <LogView log={run.log} />
        </Panel>
      )}
    </div>
  );
}
