import { Link, useParams } from "react-router";
import { FAILURE_CATALOG } from "@shared/failures";
import { OFFICIAL_LIMIT, isTerminal } from "@shared/schema";
import { Button } from "@/components/Button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { FailureCard } from "@/components/FailureCard";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { LogView } from "@/components/LogView";
import { PrimaryMetric, SupportingMetrics } from "@/components/MetricBlock";
import { Panel } from "@/components/Panel";
import { PhaseRail } from "@/components/PhaseRail";
import { ShaChip } from "@/components/ShaChip";
import { StatusChip } from "@/components/StatusChip";
import {
  formatDateTime,
  formatDurationMs,
  runNumberLabel,
} from "@/lib/format";
import {
  DEFAULT_BENCHMARK,
  useDashboard,
  usePromote,
  useRun,
  useSelectResult,
  useStartPractice,
} from "@/lib/queries";
import { STATUS_LABELS } from "@/lib/run-meta";

/**
 * Run detail (plan §8): the phase rail, then exactly one of — live progress,
 * a failure with its corrective action, or results with the next meaningful
 * action (promote / publish). Practice runs show capped logs; official runs
 * show aggregate metrics and safe diagnostics only.
 */
export function RunDetailPage() {
  const { runId = "" } = useParams();
  const runQuery = useRun(runId);
  // Cached alongside the dashboard — supplies quota and selection context.
  const dashboard = useDashboard(DEFAULT_BENCHMARK);
  const promote = usePromote();
  const select = useSelectResult();
  const retry = useStartPractice(DEFAULT_BENCHMARK);

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
              ? "Hidden evaluation — logs suppressed."
              : "Updates every 2 s."}
          </p>
        )}
      </Panel>

      {/* ── Failure ── */}
      {run.failure && failureCopy && (
        <div className="mt-4 space-y-4">
          <FailureCard failure={run.failure} mode={run.mode} />
          {run.mode === "practice" && failureCopy.retryable && (
            <Button
              variant="ghost"
              busy={retry.isPending}
              onClick={() => retry.mutate(run.branch)}
            >
              Run practice again on {run.branch}
            </Button>
          )}
          {run.mode === "official" &&
            !run.failure.consumedAttempt &&
            run.parentRunId && (
              <div className="flex flex-wrap items-center gap-3">
                <ConfirmButton
                  label="Promote the candidate again"
                  confirmLabel={`Confirm — uses attempt ${(quota?.officialUsed ?? 0) + 1} of ${OFFICIAL_LIMIT}`}
                  onConfirm={() => promote.mutate(run.parentRunId!)}
                  busy={promote.isPending}
                  disabled={!!quota && quota.officialUsed >= quota.officialLimit}
                />
                <span className="font-mono text-[11px] text-ink-faint">
                  same commit, same prepared environment
                </span>
              </div>
            )}
        </div>
      )}

      {/* ── Results ── */}
      {run.status === "succeeded" && primary && (
        <Panel label="RESULTS" className="mt-4">
          <div className="grid items-start gap-6 sm:grid-cols-2">
            <PrimaryMetric metric={primary} />
            <SupportingMetrics metrics={supporting} />
          </div>
          <p className="mt-4 border-t border-rule-soft pt-3 font-mono text-[11px] text-ink-faint">
            {run.mode === "practice"
              ? "Public practice split."
              : "Hidden official split."}
          </p>
        </Panel>
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
              confirmLabel={`Confirm — uses attempt ${(quota?.officialUsed ?? 0) + 1} of ${OFFICIAL_LIMIT}`}
              onConfirm={() => promote.mutate(run.id)}
              busy={promote.isPending}
              disabled={!!quota && quota.officialUsed >= quota.officialLimit}
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
                Publishes this run as your team's public result. You can switch
                to another successful official run at any time — free.
              </p>
              <ConfirmButton
                variant="primary"
                className="mt-4"
                label="Publish to leaderboard"
                confirmLabel="Confirm — make this the public result"
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
