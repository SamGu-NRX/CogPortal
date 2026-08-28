import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  RunLifecycleStage,
  RunStreamEvent,
  RunSurfaceAction,
  RunSurfaceSnapshot,
} from "@cogworks/contracts/schema";
import {
  collapseRepeatedRunEvents,
  runSurfaceCurrentEvents,
  runSurfaceCurrentRunId,
} from "@cogworks/contracts/schema";
import type { StreamState } from "@/lib/run-surface-stream";

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

function stageMark(snapshot: RunSurfaceSnapshot, stage: RunLifecycleStage): string {
  const active = STAGES.findIndex((item) => item.id === snapshot.stage);
  const index = STAGES.findIndex((item) => item.id === stage);
  if (index < active || snapshot.stage === "published") return "✓";
  if (index > active) return "○";
  if (snapshot.status === "failed" || snapshot.status === "cancelled") return "×";
  if (snapshot.status === "running") return "●";
  return "✓";
}

function statusCopy(snapshot: RunSurfaceSnapshot): string {
  if (snapshot.status === "failed") return "Stopped during evaluation";
  if (snapshot.status === "cancelled") return "Stopped before completion";
  if (snapshot.status === "succeeded") return "Bench clear";
  const phase = snapshot.phase.replaceAll("_", " ");
  return `On the bench · ${phase}`;
}

function connectionCopy(snapshot: RunSurfaceSnapshot, streamState: StreamState): string {
  if (snapshot.status === "succeeded") return "Complete";
  if (snapshot.status === "failed") return "Stopped";
  if (snapshot.status === "cancelled") return "Cancelled";
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
    <li className="run-event grid grid-cols-[3.75rem_minmax(0,1fr)] gap-3 border-b border-rule-soft px-4 py-3 last:border-b-0">
      <time className="font-mono text-[11px] text-ink-faint u-tnum">
        {event.elapsedMs == null ? "—" : formatElapsed(event.elapsedMs)}
      </time>
      <span className="min-w-0 text-[13px] text-ink-secondary">
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
  busyAction = null,
  error = null,
  embedded = false,
  compact = false,
}: {
  snapshot: RunSurfaceSnapshot;
  streamState: StreamState;
  onAction?: (action: Mutation) => void | Promise<void>;
  onOpenPortal?: () => void;
  busyAction?: Mutation | null;
  error?: string | null;
  embedded?: boolean;
  compact?: boolean;
}) {
  const logRef = useRef<HTMLUListElement>(null);
  const atBottomRef = useRef(true);
  const [newEvents, setNewEvents] = useState(0);
  const currentRunId = runSurfaceCurrentRunId(snapshot);
  const currentEvents = runSurfaceCurrentEvents(snapshot);
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
  const timelineEvents = collapseRepeatedRunEvents(currentEvents);
  const visibleEvents = terminal && !historyExpanded ? timelineEvents.slice(-3) : timelineEvents;

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

  useEffect(() => {
    setHistoryExpanded(false);
  }, [snapshot.id, snapshot.stage, snapshot.status]);

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
  };

  const ask = (action: RunSurfaceAction) => {
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
    ? `Use official attempt ${snapshot.nextOfficialAttempt ?? "—"} of 3 for ${snapshot.benchmark.title} at ${snapshot.shortSha}?`
    : pendingAction === "publish_result"
      ? `Publish ${snapshot.shortSha} to the public leaderboard?`
      : "Start a new hosted lifecycle at this exact commit? The current result stays unchanged.";
  const progressRatio = snapshot.progress
    ? Math.min(1, snapshot.progress.current / snapshot.progress.total)
    : null;
  const statusTone = snapshot.status === "running"
    ? "anim-live bg-detect"
    : snapshot.status === "succeeded"
      ? "bg-verify"
      : "bg-detect";

  return (
    <section
      className={`run-console mx-auto w-full overflow-hidden border border-rule bg-paper-raised shadow-[0_18px_55px_rgb(28_38_55/0.08)] ${embedded ? "max-w-[72rem]" : "max-w-6xl"}`}
      aria-label={`Live run for ${snapshot.benchmark.title}`}
      aria-busy={snapshot.status === "running"}
      data-compact={compact || undefined}
    >
      <header className={`border-b border-rule px-4 ${compact ? "py-3" : "py-4 sm:px-6 sm:py-5"}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className={`size-2 ${statusTone}`} aria-hidden="true" />
            <span className="u-kicker">{statusCopy(snapshot)}</span>
            {snapshot.simulated && (
              <span className="border border-ochre/30 bg-ochre/8 px-2 py-0.5 font-mono text-[10px] tracking-[0.08em] text-ochre">SIMULATED</span>
            )}
          </div>
          <span className="font-mono text-[11px] text-ink-faint" aria-live="polite">
            {connectionCopy(snapshot, streamState)}
          </span>
        </div>
        <div className={`${compact ? "mt-3" : "mt-5"} grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end`}>
          <div className="min-w-0">
            <h1 className="text-[clamp(1.55rem,4vw,2.45rem)]">{snapshot.benchmark.title}</h1>
            <p className={`${compact ? "mt-1" : "mt-2"} flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-ink-secondary`}>
              <span>{snapshot.team.name}</span><span aria-hidden="true">·</span>
              <span>@{snapshot.actor.login}</span><span aria-hidden="true">·</span>
              <code>{snapshot.shortSha}</code><span aria-hidden="true">·</span>
              <span className="u-tnum">{formatElapsed(snapshot.elapsedMs)}</span>
            </p>
          </div>
          {snapshot.primaryMetric && (
            <div className="min-w-36 border-l-2 border-verify pl-4">
              <div className="u-kicker">{snapshot.primaryMetric.label}</div>
              <div className="mt-1 font-serif text-3xl font-semibold u-tnum">{formatMetric(snapshot)}</div>
            </div>
          )}
        </div>
        {snapshot.status === "running" && (
          <div className="mt-4 border-t border-rule-soft pt-3" role="status" aria-live="polite">
            <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
              <span className="min-w-0 truncate text-[13px] font-medium capitalize">{currentStepCopy(snapshot)}</span>
              {snapshot.progress && (
                <span className="shrink-0 font-mono text-[11px] text-ink-secondary u-tnum">
                  {snapshot.progress.current}/{snapshot.progress.total} {snapshot.progress.unit}
                </span>
              )}
            </div>
            <div
              className="h-1.5 overflow-hidden bg-paper-sunken"
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

      <ol className="grid grid-cols-4 border-b border-rule" aria-label="Run lifecycle">
        {STAGES.map((stage) => {
          const mark = stageMark(snapshot, stage.id);
          return (
            <li
              key={stage.id}
              aria-current={stage.id === snapshot.stage ? "step" : undefined}
              className={`flex items-center justify-center gap-2 border-r border-rule-soft px-2 last:border-r-0 sm:justify-start sm:px-4 ${compact ? "min-h-11" : "min-h-14"}`}
            >
              <span className={`font-mono text-[15px] ${mark === "×" ? "text-detect" : mark === "○" ? "text-ink-faint" : "text-verify"}`} aria-hidden="true">{mark}</span>
              <span className={`${compact ? "hidden sm:inline" : "hidden min-[420px]:inline"} text-[11px] font-medium uppercase tracking-[0.05em]`}>{stage.label}</span>
              <span className="sr-only">{mark === "✓" ? "complete" : mark === "●" ? "active" : mark === "×" ? "failed" : "pending"}</span>
            </li>
          );
        })}
      </ol>

      {!compact && (
      <div className="grid md:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="relative border-b border-rule md:border-r md:border-b-0">
          <div className="flex items-center justify-between border-b border-rule-soft px-4 py-3">
            <span className="u-kicker">{terminal ? "Run summary" : "Safe event stream"}</span>
            {terminal && timelineEvents.length > 3 && (
              <button
                type="button"
                className="min-h-9 px-2 text-[11px] text-ink-secondary underline decoration-rule underline-offset-4"
                aria-expanded={historyExpanded}
                onClick={() => setHistoryExpanded((expanded) => !expanded)}
              >
                {historyExpanded ? "Show summary" : `Show all ${timelineEvents.length}`}
              </button>
            )}
          </div>
          <ul
            ref={logRef}
            tabIndex={terminal && !historyExpanded ? undefined : 0}
            aria-label={terminal ? "Run event summary" : "Live run events"}
            className={`log-scroll bg-paper-sunken/30 focus-visible:outline-offset-[-2px] ${terminal && !historyExpanded ? "" : "h-[min(34vh,18rem)] overflow-y-auto"}`}
            onScroll={(event) => {
              const node = event.currentTarget;
              const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
              atBottomRef.current = bottom;
              if (bottom) setNewEvents(0);
            }}
          >
            {visibleEvents.length ? visibleEvents.map((event) => <EventLine key={event.eventId} event={event} />) : (
              <li className="px-5 py-12 text-center text-[13px] text-ink-faint">Waiting for the first structured event.</li>
            )}
          </ul>
          {newEvents > 0 && (
            <button
              type="button"
              className="absolute bottom-3 left-1/2 min-h-9 -translate-x-1/2 border border-rule bg-ink px-3 text-[12px] text-paper-raised shadow-md"
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
          <div className="u-kicker">Run reference</div>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px]">
            <dt className="text-ink-faint">Commit</dt><dd className="min-w-0 truncate font-mono">{snapshot.sha}</dd>
            <dt className="text-ink-faint">Branch</dt><dd className="min-w-0 truncate font-mono">{snapshot.branch ?? "detached"}</dd>
            <dt className="text-ink-faint">Workspace</dt><dd>{snapshot.dirty ? "Uncommitted changes" : "Clean"}</dd>
          </dl>
          <div className="mt-6 grid gap-2">
            {snapshot.actions.filter((action) => ACTION_COPY[action]).map((action) => (
              <button
                key={action}
                type="button"
                disabled={busyAction !== null}
                className={`u-pressable min-h-11 border px-3 text-left text-[12px] font-medium transition-colors duration-150 disabled:opacity-50 ${action === "promote_official" || action === "publish_result" ? "border-detect bg-detect text-paper-raised" : "border-rule bg-paper-raised hover:border-ink-secondary"}`}
                onClick={() => ask(action)}
              >
                {busyAction === action ? "Working…" : ACTION_COPY[action]}
              </button>
            ))}
            {onOpenPortal && (
              <button type="button" className="min-h-11 px-3 text-left text-[12px] text-ink-secondary underline decoration-rule underline-offset-4" onClick={onOpenPortal}>
                Open Cog*Portal ↗
              </button>
            )}
          </div>
          {error && <p role="alert" className="mt-4 border-l-2 border-detect pl-3 text-[12px] text-detect-deep">{error}</p>}
          {snapshot.status === "failed" && (
            <p className="mt-4 text-[12px] text-ink-secondary">The useful detail is still in the runner's terminal.</p>
          )}
        </aside>
      </div>
      )}

      {(pendingAction || showCommand) && (
        <dialog
          ref={dialogRef}
          aria-labelledby="run-action-title"
          className="m-auto w-[calc(100%-2rem)] max-w-md border border-rule bg-paper-raised p-5 text-ink shadow-2xl backdrop:bg-ink/45 anim-rise"
          onCancel={(event) => { event.preventDefault(); closeDialog(); }}
          onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}
        >
            <div className="u-kicker">{showCommand ? "Run locally" : "Confirm action"}</div>
            <h2 id="run-action-title" className="mt-2 text-2xl">{showCommand ? "Back to the bench" : ACTION_COPY[pendingAction ?? "run_again"]}</h2>
            {showCommand ? (
              <code className="mt-4 block overflow-x-auto border border-rule bg-paper-sunken/45 p-3 text-[12px]">cogworks run --benchmark {snapshot.benchmark.id} --live</code>
            ) : <p className="mt-3 text-[14px] text-ink-secondary">{confirmation}</p>}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="min-h-11 border border-rule px-4 text-[13px]" onClick={closeDialog}>Close</button>
              {pendingAction && (
                <button type="button" className="min-h-11 bg-detect px-4 text-[13px] font-medium text-paper-raised" onClick={() => {
                  const action = pendingAction;
                  setPendingAction(null);
                  void onAction?.(action);
                }}>Confirm</button>
              )}
            </div>
        </dialog>
      )}
    </section>
  );
}
