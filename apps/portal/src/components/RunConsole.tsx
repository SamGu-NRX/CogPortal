import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  RunLifecycleStage,
  RunLifecycleStageState,
  RunStreamEvent,
  RunSurfaceAction,
  RunSurfaceSnapshot,
} from "@cogworks/contracts/schema";
import {
  OFFICIAL_LIMIT,
  collapseRepeatedRunEvents,
  runSurfaceCurrentEvents,
  runSurfaceCurrentRunId,
  runSurfaceStageStates,
} from "@cogworks/contracts/schema";
import type { StreamState } from "@/lib/run-surface-stream";
import type { RunSurfaceMutationInput } from "@/lib/api";
import { buttonClass } from "./Button";
import { Code } from "./Code";
import { SimulatedChip } from "./SimulatedChip";
import { Veil } from "./Veil";

type Mutation = "verify_hosted" | "promote_official" | "publish_result" | "rerun_hosted";

const STAGES: { id: RunLifecycleStage; label: string }[] = [
  { id: "local", label: "Local" },
  { id: "hosted", label: "Hosted" },
  { id: "official", label: "Official" },
  { id: "published", label: "Published" },
];

const EVENT_COPY: Record<RunStreamEvent["code"], string> = {
  "repository.ready": "Repository ready",
  "repository.fetching": "Fetching repository",
  "dependencies.installing": "Installing dependencies",
  "contract.checking": "Checking benchmark contract",
  "contract.passed": "Contract passed",
  "evaluation.started": "Evaluation started",
  "evaluation.progress": "Evaluating",
  "scoring.started": "Scoring result",
  "run.completed": "Run complete",
  "run.failed.repository": "Repository could not be prepared",
  "run.failed.dependencies": "Dependencies could not be installed",
  "run.failed.contract": "Benchmark contract needs attention",
  "run.failed.runtime": "Submission stopped during evaluation",
  "run.failed.timeout": "Evaluation reached its time limit",
  "run.failed.memory": "Evaluation reached its memory limit",
  "run.failed.output": "Submission returned an invalid output",
  "run.failed.scorer": "Scoring could not finish",
  "run.failed.provider": "The hosted runner could not finish",
};

const ACTION_COPY: Partial<Record<RunSurfaceAction, string>> = {
  verify_hosted: "Verify hosted",
  run_again: "Run again",
  promote_official: "Promote to official",
  rerun_hosted: "Rerun hosted",
  publish_result: "Publish result",
};

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

function formatMetric(snapshot: RunSurfaceSnapshot): string | null {
  const metric = snapshot.primaryMetric;
  if (!metric) return null;
  const value = metric.value.toFixed(metric.precision);
  return metric.unit ? `${value} ${metric.unit}` : value;
}

const STAGE_MARKS: Record<RunLifecycleStageState, { mark: string; tone: string; label: string }> = {
  complete: { mark: "✓", tone: "text-verify", label: "complete" },
  active: { mark: "●", tone: "text-verify", label: "active" },
  failed: { mark: "×", tone: "text-detect", label: "failed" },
  cancelled: { mark: "×", tone: "text-detect", label: "stopped" },
  pending: { mark: "○", tone: "text-ink-faint", label: "pending" },
  not_run: { mark: "–", tone: "text-ink-faint", label: "not run" },
};

function statusCopy(snapshot: RunSurfaceSnapshot): string {
  if (snapshot.status === "failed") return "Run failed";
  if (snapshot.status === "cancelled") return "Stopped before completion";
  if (snapshot.status === "succeeded") return "Bench clear";
  const phase = snapshot.phase.replaceAll("_", " ");
  return snapshot.silentSince === null ? `On the bench · ${phase}` : `Lost contact · ${phase}`;
}

/** An abandoned session can sit for days, so past today the date is shown too. */
function formatHeard(ms: number): string {
  const heard = new Date(ms);
  const today = heard.toDateString() === new Date().toDateString();
  return heard.toLocaleString([], today
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function connectionCopy(snapshot: RunSurfaceSnapshot, streamState: StreamState): string {
  if (snapshot.status === "succeeded") return "Complete";
  if (snapshot.status === "failed") return "Stopped";
  if (snapshot.status === "cancelled") return "Cancelled";
  // The socket can be live while the run it reports on has gone quiet.
  if (snapshot.silentSince !== null) return `Last heard ${formatHeard(snapshot.silentSince)}`;
  if (streamState === "live") return "Live";
  if (streamState === "closed") return "Snapshot";
  return "Reconnecting…";
}

function currentStepCopy(snapshot: RunSurfaceSnapshot): string {
  const latest = runSurfaceCurrentEvents(snapshot).at(-1);
  if (latest) return EVENT_COPY[latest.code];
  return snapshot.phase.replaceAll("_", " ");
}

function EventLine({ event }: { event: RunStreamEvent }) {
  const progress = event.progress
    ? ` · ${event.progress.current}/${event.progress.total} ${event.progress.unit}`
    : "";
  return (
    <li className="run-event grid grid-cols-[3.75rem_minmax(0,1fr)] gap-3 border-b border-rule-soft px-4 py-2.5 last:border-b-0 sm:px-5">
      <time className="font-mono text-[12px] text-ink-faint u-tnum">
        {event.elapsedMs == null ? "—" : formatElapsed(event.elapsedMs)}
      </time>
      <span className="min-w-0 text-[13.5px] text-ink-secondary">
        {EVENT_COPY[event.code]}{progress}
      </span>
    </li>
  );
}

export function RunConsole({
  snapshot,
  streamState,
  onAction,
  onOpenPortal,
  onOpenRun,
  busyAction = null,
  error = null,
  embedded = false,
  compact = false,
}: {
  snapshot: RunSurfaceSnapshot;
  streamState: StreamState;
  onAction?: (input: RunSurfaceMutationInput) => void | Promise<void>;
  onOpenPortal?: () => void;
  onOpenRun?: (runId: string) => void;
  busyAction?: Mutation | "retry" | null;
  error?: string | null;
  embedded?: boolean;
  compact?: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryFocusedRef = useRef(false);
  const runAgainFocusedRef = useRef(false);
  const dialogOpenerRef = useRef<HTMLElement | null>(null);
  const retryInFlightRef = useRef(false);
  const logRef = useRef<HTMLUListElement>(null);
  const logFocusedRef = useRef(false);
  const historyToggleRef = useRef<HTMLButtonElement>(null);
  const atBottomRef = useRef(true);
  const [newEvents, setNewEvents] = useState(0);
  const currentRunId = runSurfaceCurrentRunId(snapshot);
  const currentEvents = runSurfaceCurrentEvents(snapshot);
  const stageStates = runSurfaceStageStates(snapshot);
  const previousEvents = useRef({
    surfaceId: snapshot.id,
    runId: currentRunId,
    count: currentEvents.length,
  });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [pendingAction, setPendingAction] = useState<Mutation | null>(null);
  const [showCommand, setShowCommand] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const terminal = snapshot.status !== "running";
  // Still running as far as the portal knows, but its CLI has gone quiet. The
  // next snapshot clears this when the run reports again or finishes.
  const silent = snapshot.status === "running" && snapshot.silentSince !== null;
  const timelineEvents = collapseRepeatedRunEvents(currentEvents);
  const failed = snapshot.status === "failed";
  const retryOffered = snapshot.actions.includes("retry") && currentRunId !== null && Boolean(onAction);
  const runAgainOffered = (failed || silent) && snapshot.stage === "local" && snapshot.actions.includes("run_again");

  const retry = async () => {
    if (!retryOffered || !onAction || !currentRunId || retryInFlightRef.current || busyAction) return;
    retryInFlightRef.current = true;
    try {
      await onAction({ surfaceId: snapshot.id, action: "retry", runId: currentRunId });
    } finally {
      retryInFlightRef.current = false;
    }
  };

  useLayoutEffect(() => {
    if (!retryOffered && retryFocusedRef.current) {
      headingRef.current?.focus();
      retryFocusedRef.current = false;
    }
  }, [retryOffered]);

  // A silent run that reports again takes its Run again button with it.
  useLayoutEffect(() => {
    if (!runAgainOffered && runAgainFocusedRef.current) {
      headingRef.current?.focus();
      runAgainFocusedRef.current = false;
    }
  }, [runAgainOffered]);

  const failureEvent = [...currentEvents].reverse().find((event) => event.code.startsWith("run.failed."));
  const failureReason = snapshot.refusalHeadline || (failureEvent ? EVENT_COPY[failureEvent.code] : null);
  // A failed run's folded summary ends at its failure and never says the run
  // completed. The Worker can fail a run after the runner reports completion,
  // and the failure event may be missing; either way the completion belongs
  // in the details, not the summary.
  let summaryEvents = timelineEvents;
  if (failed) {
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
      if (timelineEvents[index]!.code.startsWith("run.failed.")) {
        summaryEvents = timelineEvents.slice(0, index + 1);
        break;
      }
    }
    summaryEvents = summaryEvents.filter((event) => event.code !== "run.completed");
  }
  const visibleEvents = terminal && !historyExpanded ? summaryEvents.slice(-3) : timelineEvents;
  const historyToggle = failed
    ? { open: "Hide details", closed: "Show details" }
    : { open: "Show summary", closed: `Show all ${timelineEvents.length}` };
  const recordedMetrics = snapshot.metrics.length > 0
    ? snapshot.metrics
    : snapshot.primaryMetric ? [snapshot.primaryMetric] : [];

  useLayoutEffect(() => {
    if (
      previousEvents.current.surfaceId !== snapshot.id
      || previousEvents.current.runId !== currentRunId
    ) {
      previousEvents.current = {
        surfaceId: snapshot.id,
        runId: currentRunId,
        count: currentEvents.length,
      };
      atBottomRef.current = true;
      setNewEvents(0);
      return;
    }
    const added = Math.max(0, currentEvents.length - previousEvents.current.count);
    previousEvents.current.count = currentEvents.length;
    if (!added || terminal) return;
    if (atBottomRef.current) {
      logRef.current?.scrollTo({
        top: logRef.current.scrollHeight,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    } else {
      setNewEvents((count) => count + added);
    }
  }, [currentEvents.length, currentRunId, snapshot.id, terminal]);

  // Folding the focused log makes it unfocusable; keep focus on the toggle.
  useLayoutEffect(() => {
    if (failed && !historyExpanded && logFocusedRef.current) {
      historyToggleRef.current?.focus();
      logFocusedRef.current = false;
    }
  }, [failed, historyExpanded]);

  useEffect(() => {
    setHistoryExpanded(false);
  }, [snapshot.id, currentRunId, snapshot.stage, snapshot.status]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || (!pendingAction && !showCommand)) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("button")?.focus();
  }, [pendingAction, showCommand]);

  const closeDialog = () => {
    setPendingAction(null);
    setShowCommand(false);
    dialogRef.current?.close();
    // The button that opened the dialog may have gone while it was open.
    const opener = dialogOpenerRef.current;
    dialogOpenerRef.current = null;
    if (opener) (opener.isConnected ? opener : headingRef.current)?.focus();
  };

  const ask = (action: RunSurfaceAction) => {
    dialogOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (action === "run_again") {
      setShowCommand(true);
      return;
    }
    if (["verify_hosted", "promote_official", "publish_result", "rerun_hosted"].includes(action)) {
      setPendingAction(action as Mutation);
    }
  };
  const confirmation = pendingAction === "verify_hosted"
    ? `Run ${snapshot.shortSha} on the hosted benchmark? This uses one of the team's shared practice runs.`
    : pendingAction === "promote_official"
    ? `Use ${snapshot.nextOfficialAttempt === null ? "an official attempt" : `official attempt ${snapshot.nextOfficialAttempt} of ${OFFICIAL_LIMIT}`} for ${snapshot.benchmark.title} at ${snapshot.shortSha}?`
    : pendingAction === "publish_result"
      ? `Publish ${snapshot.shortSha} to the public leaderboard?`
      : "Start a new hosted lifecycle at this exact commit? The current result stays unchanged.";
  const progressRatio = snapshot.progress
    ? Math.min(1, snapshot.progress.current / snapshot.progress.total)
    : null;
  const statusTone = silent
    ? "bg-ink-faint"
    : snapshot.status === "running"
    ? "anim-live bg-detect"
    : snapshot.status === "succeeded"
      ? "bg-verify"
      : "bg-detect";

  const confirmAction = pendingAction === "verify_hosted"
    ? "Run it hosted"
    : pendingAction === "promote_official"
      ? snapshot.nextOfficialAttempt === null
        ? "Use an official attempt"
        : `Use attempt ${snapshot.nextOfficialAttempt} of ${OFFICIAL_LIMIT}`
      : pendingAction === "publish_result"
        ? "Publish"
        : "Start a new run";

  return (
    <section
      className={`run-console mx-auto w-full overflow-hidden rounded-surface border border-rule bg-paper-raised shadow-[0_1px_0_rgb(27_31_36/0.04),0_18px_40px_-28px_rgb(27_31_36/0.3)] ${embedded ? "max-w-[72rem]" : "max-w-6xl"}`}
      aria-label={`${silent ? "Run" : "Live run"} for ${snapshot.benchmark.title}`}
      aria-busy={snapshot.status === "running" && !silent}
      data-compact={compact || undefined}
    >
      <header className={`border-b border-rule px-4 ${compact ? "py-3.5" : "py-5 sm:px-6 sm:py-6"}`}>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={`size-2 shrink-0 rounded-[1.5px] ${statusTone}`} aria-hidden="true" />
            <span className={`text-[13.5px] font-semibold ${failed ? "text-detect-deep" : snapshot.status === "succeeded" ? "text-verify-deep" : "text-ink"}`}>
              {statusCopy(snapshot)}
            </span>
            {snapshot.simulated && <SimulatedChip />}
          </div>
          <span className="font-mono text-[12px] text-ink-faint" aria-live="polite">
            {connectionCopy(snapshot, streamState)}
          </span>
        </div>
        {/* No breakpoint in the tile, for the reason the lifecycle row below
            gives: Discord can put a 352px tile on a 768px screen. */}
        <div className={`${compact ? "mt-2.5" : "mt-4"} grid gap-4 ${compact ? "" : "md:grid-cols-[minmax(0,1fr)_auto] md:items-end"}`}>
          <div className="min-w-0">
            <h1 ref={headingRef} tabIndex={-1} className={compact ? "text-[1.5rem]" : "text-[clamp(1.6rem,1.2rem+1.8vw,2.4rem)]"}>{snapshot.benchmark.title}</h1>
            <p className={`${compact ? "mt-1" : "mt-2"} flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13.5px] text-ink-secondary`}>
              <span>{snapshot.team.name}</span><span aria-hidden="true" className="text-ink-faint">·</span>
              <span>@{snapshot.actor.login}</span><span aria-hidden="true" className="text-ink-faint">·</span>
              <code className="font-mono text-[12.5px]">{snapshot.shortSha}</code><span aria-hidden="true" className="text-ink-faint">·</span>
              <span className="u-tnum font-mono text-[12.5px]">{formatElapsed(snapshot.elapsedMs)}</span>
            </p>
          </div>
          {snapshot.status === "succeeded" && snapshot.primaryMetric && (
            <div className="min-w-36 border-l-2 border-verify pl-4">
              <div className="text-[13px] font-semibold text-ink-secondary">{snapshot.primaryMetric.label}</div>
              <div className="u-tnum mt-0.5 font-mono text-[24px] font-medium text-ink">{formatMetric(snapshot)}</div>
            </div>
          )}
        </div>
        {failed && failureReason && (
          <p className="mt-3 max-w-[60ch] text-[15px] leading-[1.5] break-words text-ink">{failureReason}</p>
        )}
        {/* The run page carries the failure's own note and its next step;
            the console only says that it failed. A local run has no page. */}
        {failed && onOpenRun && currentRunId && snapshot.stage !== "local" && (
          <button
            type="button"
            className="u-link mt-1 inline-flex min-h-11 items-center text-[14px]"
            onClick={() => onOpenRun(currentRunId)}
          >
            See why it failed
          </button>
        )}
        {silent && (
          <p className="mt-5 max-w-[60ch] border-t border-rule-soft pt-3.5 text-[14px] leading-[1.55] text-ink-secondary" role="status" aria-live="polite">
            If @{snapshot.actor.login}'s run is still going, its result will appear here when it finishes. If it was stopped, run it again.
          </p>
        )}
        {runAgainOffered && (
          <div className="mt-4">
            <button
              type="button"
              className={buttonClass(failed ? "primary" : "ghost")}
              onFocus={() => { runAgainFocusedRef.current = true; }}
              onBlur={() => { runAgainFocusedRef.current = false; }}
              onClick={() => ask("run_again")}
            >
              Run again
            </button>
          </div>
        )}
        {retryOffered && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              className={buttonClass("primary")}
              aria-disabled={busyAction !== null}
              onFocus={() => { retryFocusedRef.current = true; }}
              onBlur={() => { retryFocusedRef.current = false; }}
              onClick={() => { void retry(); }}
            >
              {busyAction === "retry" ? "Retrying…" : "Retry"}
            </button>
            <p className="text-[13.5px] text-ink-secondary">Runs the same commit again.</p>
          </div>
        )}
        {/* The slot Retry would occupy. The server only sends this when the
            recorded inputs themselves cannot be sent again, so it is the only
            case we can name; its absence says nothing about quota or access.
            The compact tile has no sidebar, so a source refusal goes here. */}
        {failed && !retryOffered && (snapshot.retryRefusal ?? (compact ? snapshot.sourceRefusal : null)) && (
          <p className="mt-4 max-w-[60ch] text-[13.5px] leading-relaxed text-ink-secondary">
            {snapshot.retryRefusal ?? snapshot.sourceRefusal}
          </p>
        )}
        {error && <p role="alert" className="mt-4 border-l-2 border-detect pl-3 text-[13.5px] text-detect-deep">{error}</p>}
        {snapshot.status === "running" && !silent && (
          <div className="mt-5 border-t border-rule-soft pt-3.5" role="status" aria-live="polite">
            <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
              <span className="min-w-0 truncate text-[14px] font-semibold first-letter:uppercase">{currentStepCopy(snapshot)}</span>
              {snapshot.progress && (
                <span className="shrink-0 font-mono text-[12px] text-ink-secondary u-tnum">
                  {snapshot.progress.current}/{snapshot.progress.total} {snapshot.progress.unit}
                </span>
              )}
            </div>
            <div
              className="h-1 overflow-hidden rounded-full bg-paper-sunken"
              role="progressbar"
              aria-label={`${currentStepCopy(snapshot)} progress`}
              aria-valuemin={snapshot.progress ? 0 : undefined}
              aria-valuemax={snapshot.progress?.total}
              aria-valuenow={snapshot.progress?.current}
            >
              <span
                className={`run-progress-fill block h-full bg-detect ${progressRatio === null ? "run-progress-indeterminate" : ""}`}
                style={progressRatio === null ? undefined : { transform: `scaleX(${progressRatio})` }}
              />
            </div>
          </div>
        )}
      </header>

      {/* `compact` is the console's own width, not the window's: a 352px tile
          can sit on a 768px screen, so the tile reads no breakpoint. Names
          stack under the mark where a quarter of the row cannot hold both. */}
      <ol className="grid grid-cols-4 border-b border-rule bg-paper/60" aria-label="Run lifecycle">
        {STAGES.map((stage) => {
          const { mark, tone, label } = STAGE_MARKS[stageStates[stage.id]];
          return (
            <li
              key={stage.id}
              aria-current={stage.id === snapshot.stage ? "step" : undefined}
              className={`flex flex-col items-center justify-center gap-0.5 border-r border-rule-soft px-1 py-1.5 last:border-r-0 ${compact ? "min-h-11" : "min-h-14 sm:flex-row sm:justify-start sm:gap-2 sm:px-4 sm:py-0"}`}
            >
              <span className={`font-mono text-[15px] leading-none ${tone}`} aria-hidden="true">{mark}</span>
              {/* The gallery's 360px viewport leaves a 277px compact row.
                  Four-pixel padding keeps "Published" on one line with the
                  loaded font; narrower rows can still wrap rather than clip. */}
              <span className={`text-center leading-tight font-semibold [overflow-wrap:anywhere] ${stage.id === snapshot.stage ? "text-ink" : "text-ink-secondary"} ${compact ? "text-[11.5px]" : "text-[11.5px] sm:text-[13px]"}`}>{stage.label}</span>
              <span className="sr-only">{label}</span>
            </li>
          );
        })}
      </ol>

      {!compact && (
      <div className="grid md:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="relative border-b border-rule md:border-r md:border-b-0">
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-rule-soft px-4 py-2 sm:px-5">
            <span className="u-label">{terminal ? "Run summary" : silent ? "Events so far" : "Live events"}</span>
            {terminal && (failed || timelineEvents.length > 3) && (
              <button
                type="button"
                className="u-link inline-flex min-h-11 items-center px-1 text-[13px] text-ink-secondary"
                ref={historyToggleRef}
                aria-expanded={historyExpanded}
                onClick={() => setHistoryExpanded((expanded) => !expanded)}
              >
                {historyExpanded ? historyToggle.open : historyToggle.closed}
              </button>
            )}
          </div>
          {failed && historyExpanded && recordedMetrics.length > 0 && (
            <div className="space-y-1 border-b border-rule-soft px-4 py-3 text-[13px] text-ink-secondary sm:px-5">
              <p className="font-semibold">Saved results</p>
              {recordedMetrics.map((metric) => (
                <p key={metric.key} className="u-tnum">{metric.label}: {metric.value.toFixed(metric.precision)}{metric.unit ? ` ${metric.unit}` : ""}</p>
              ))}
            </div>
          )}
          <ul
            ref={logRef}
            onFocus={() => { logFocusedRef.current = true; }}
            onBlur={() => { logFocusedRef.current = false; }}
            tabIndex={terminal && !historyExpanded ? undefined : 0}
            aria-label={terminal ? "Run event summary" : silent ? "Run events so far" : "Live run events"}
            className={`log-scroll bg-paper-sunken/30 focus-visible:outline-offset-[-2px] ${terminal && !historyExpanded ? "" : "h-[min(34vh,18rem)] overflow-y-auto"}`}
            onScroll={(event) => {
              const node = event.currentTarget;
              const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
              atBottomRef.current = bottom;
              if (bottom) setNewEvents(0);
            }}
          >
            {visibleEvents.length ? visibleEvents.map((event) => <EventLine key={event.eventId} event={event} />) : (
              <li className="px-5 py-12 text-center text-[13.5px] text-ink-faint">{silent ? "Nothing arrived before contact was lost." : !terminal ? "Waiting for the first event from the runner." : timelineEvents.length ? "This run's events are under Show details." : "No structured events were recorded."}</li>
            )}
          </ul>
          {!terminal && newEvents > 0 && (
            <button
              type="button"
              className="absolute bottom-3 left-1/2 min-h-9 -translate-x-1/2 rounded-full border border-ink bg-ink px-3.5 text-[13px] font-semibold text-paper-raised shadow-md"
              onClick={() => {
                logRef.current?.scrollTo({
                  top: logRef.current.scrollHeight,
                  behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                });
                atBottomRef.current = true;
                setNewEvents(0);
              }}
            >
              {newEvents} new {newEvents === 1 ? "event" : "events"}
            </button>
          )}
        </div>

        <aside className="p-4 sm:p-5">
          <div className="u-label">Run reference</div>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-ink-faint">Repository</dt>
            <dd className="min-w-0 truncate font-mono text-[12.5px]" title={snapshot.source?.fullName}>
              {snapshot.source ? snapshot.source.fullName : "not recorded"}
            </dd>
            <dt className="text-ink-faint">Commit</dt><dd className="min-w-0 truncate font-mono text-[12.5px]" title={snapshot.sha}>{snapshot.sha}</dd>
            <dt className="text-ink-faint">Branch</dt><dd className="min-w-0 truncate font-mono text-[12.5px]">{snapshot.branch ?? "detached"}</dd>
            <dt className="text-ink-faint">Workspace</dt><dd>{snapshot.dirty ? "Uncommitted changes" : "Clean"}</dd>
          </dl>
          {/* The server refuses these for a run that is not about the connected
              repository, or whose saved environment can no longer be reused, so
              the buttons are gone. Saying why beats a panel that quietly lost
              its controls. One sentence: the source answer comes first on the
              server, so it is the one that applies. */}
          {(snapshot.sourceRefusal ?? snapshot.promotionRefusal) && (
            <p className="mt-4 max-w-prose text-[13px] leading-relaxed text-ink-secondary">
              {snapshot.sourceRefusal ?? snapshot.promotionRefusal}
            </p>
          )}
          <div className="mt-6 grid gap-2">
            {/* A failed or silent local run offers Run again in the header. */}
            {snapshot.actions.filter((action) => !failed && !silent && ACTION_COPY[action]).map((action) => (
              <button
                key={action}
                type="button"
                disabled={busyAction !== null}
                className={buttonClass(
                  action === "promote_official" || action === "publish_result" ? "official" : "ghost",
                  "w-full !justify-start px-4 text-[14px]",
                )}
                onClick={() => ask(action)}
              >
                {busyAction === action ? "Working…" : ACTION_COPY[action]}
              </button>
            ))}
            {/* The reference above states "Uncommitted changes" and the
                hosted action silently disappears, so the one fact that
                explains the missing button was the one thing not said. */}
            {snapshot.dirty && snapshot.stage === "local" && snapshot.status === "succeeded" && (
              <p className="text-[13px] leading-relaxed text-ink-secondary">
                Hosted verification needs a commit. Commit and push this work,
                then run it again.
              </p>
            )}
            {onOpenPortal && (
              <button type="button" className="u-link inline-flex min-h-11 items-center gap-1 text-left text-[13.5px] text-ink-secondary" onClick={onOpenPortal}>
                Open Cog*Portal
                <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
          </div>
        </aside>
      </div>
      )}

      {snapshot.executionHistory.length > 0 && (
        <div className="border-t border-rule px-4 py-3 sm:px-6">
          <Veil count={snapshot.executionHistory.length} peek={0} moreLabel="Show run history" fewerLabel="Hide run history">
            <ol className="divide-y divide-rule-soft" aria-label="Run history">
              {snapshot.executionHistory.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13.5px]">
                  <div>
                    <p className="first-letter:uppercase">{run.mode} · {run.status.replaceAll("_", " ")}{run.id === currentRunId ? " · current" : ""}</p>
                    <time className="font-mono text-[12px] text-ink-faint" dateTime={new Date(run.createdAt).toISOString()}>{new Date(run.createdAt).toLocaleString()}</time>
                  </div>
                  {onOpenRun && <button type="button" className="u-link inline-flex min-h-11 items-center px-1 text-[13.5px]" onClick={() => onOpenRun(run.id)}>View details<span className="sr-only"> for {run.mode} run from {new Date(run.createdAt).toLocaleString()}</span></button>}
                </li>
              ))}
            </ol>
          </Veil>
        </div>
      )}

      {(pendingAction || showCommand) && (
        <dialog
          ref={dialogRef}
          aria-labelledby="run-action-title"
          className="m-auto w-[calc(100%-2rem)] max-w-md rounded-surface border border-rule bg-paper-raised p-6 text-ink shadow-2xl backdrop:bg-ink/40 anim-rise"
          onCancel={(event) => { event.preventDefault(); closeDialog(); }}
          // The restore gate closes open dialogs natively; follow it.
          onClose={() => { if (pendingAction || showCommand) closeDialog(); }}
          onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}
        >
            <div className="u-label">{showCommand ? "Run locally" : "Confirm action"}</div>
            <h2 id="run-action-title" className="mt-1.5 text-[24px]">{showCommand ? "Back to the bench" : ACTION_COPY[pendingAction ?? "run_again"]}</h2>
            {showCommand ? (
              <div className="mt-4">
                <Code lang="bash" code={`cogworks run --benchmark ${snapshot.benchmark.id} --live`} wrap />
              </div>
            ) : <p className="mt-3 text-[14.5px] leading-[1.55] text-ink-secondary">{confirmation}</p>}
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <button type="button" className={buttonClass("ghost")} onClick={closeDialog}>Close</button>
              {/* Named by its consequence, the way every confirm in the portal
                  is, so the button says what pressing it does. */}
              {pendingAction && (
                <button type="button" className={buttonClass(pendingAction === "promote_official" || pendingAction === "publish_result" ? "official" : "primary")} onClick={() => {
                  const action = pendingAction;
                  setPendingAction(null);
                  void onAction?.({ surfaceId: snapshot.id, action });
                }}>{confirmAction}</button>
              )}
            </div>
        </dialog>
      )}
    </section>
  );
}
