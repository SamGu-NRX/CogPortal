import { useState } from "react";
import { Link } from "react-router";
import { OFFICIAL_LIMIT } from "@shared/schema";
import { Button } from "@/components/Button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { EmptyState } from "@/components/EmptyState";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { Panel } from "@/components/Panel";
import { PhaseRail } from "@/components/PhaseRail";
import { QuotaCells } from "@/components/QuotaCells";
import { RunList } from "@/components/RunList";
import { ShaChip } from "@/components/ShaChip";
import { StatusChip } from "@/components/StatusChip";
import { ApiRequestError } from "@/lib/api";
import { formatMetricValue, formatTimeAgo, runNumberLabel } from "@/lib/format";
import {
  DEFAULT_BENCHMARK,
  useDashboard,
  usePromote,
  useRepositories,
  useStartPractice,
} from "@/lib/queries";
import { STATUS_LABELS } from "@/lib/run-meta";

/**
 * The team dashboard answers, at a glance (plan §8): what's connected, what
 * SHA was last tested, which benchmark version is active, what the current
 * run is doing, what failed and what to do, what budget remains, and what is
 * currently public.
 */
export function DashboardPage() {
  const dashboard = useDashboard(DEFAULT_BENCHMARK);
  const repositories = useRepositories();

  if (dashboard.isPending) return <LoadingMark label="Loading" />;
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

  return (
    <div className="anim-rise py-12">
      {/* ── Masthead ── */}
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <p className="u-kicker">Team dashboard</p>
          <h1 className="mt-1 text-3xl">
            <Link to="/team" className="hover:underline hover:decoration-rule hover:underline-offset-8">
              {d.team.name}
            </Link>
          </h1>
        </div>
        <p className="font-mono text-[11.5px] tracking-[0.05em] text-ink-secondary">
          {d.benchmark.title} · v{d.benchmark.version}
        </p>
      </header>

      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        {/* ── Left column: the live instrument ── */}
        <div className="space-y-4 lg:col-span-2">
          <CurrentRunPanel
            dashboard={d}
            branches={branches}
            practiceLeft={practiceLeft}
            officialLeft={officialLeft}
          />

          <Panel
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
              <dl className="space-y-3 text-[13.5px]">
                <div>
                  <dt className="u-kicker">Repository</dt>
                  <dd className="mt-1">
                    <a
                      href={d.team.repo.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[13px] text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
                    >
                      {d.team.repo.fullName}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt className="u-kicker">Last resolved commit</dt>
                  <dd className="mt-1">
                    {d.lastResolvedSha ? (
                      <ShaChip sha={d.lastResolvedSha} shortSha={d.lastResolvedSha.slice(0, 7)} />
                    ) : (
                      <span className="font-mono text-[12px] text-ink-faint">
                        none yet — start a practice run
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="u-kicker">Runtime</dt>
                  <dd className="mt-1 font-mono text-[12px] text-ink-secondary">
                    Python 3.8.20 · CPU · offline eval
                  </dd>
                </div>
              </dl>
            ) : (
              <EmptyState message="No repository connected." />
            )}
          </Panel>

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
              <p className="border-t border-rule-soft pt-3 font-mono text-[11px] leading-relaxed text-ink-faint">
                Local practice is unlimited. Official attempts are consumed
                only once hidden evaluation begins.
              </p>
            </div>
          </Panel>

          <Panel label="PUBLISHED RESULT" tone={d.selection ? "good" : "default"}>
            {d.selection ? (
              <div>
                <div className="u-tnum font-serif text-4xl font-semibold text-ink">
                  {d.selection.primaryMetric.value.toFixed(d.selection.primaryMetric.precision)}
                </div>
                <p className="mt-1 font-mono text-[11px] tracking-[0.05em] text-ink-secondary">
                  {d.selection.primaryMetric.label}
                  {d.selection.attemptNumber
                    ? ` · attempt #${d.selection.attemptNumber}`
                    : ""}{" "}
                  · {d.selection.shortSha}
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
              </div>
            ) : (
              <EmptyState message="Nothing published yet. Promote a successful practice run, then select the official result you want public." />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

/* ── Current run / launch controls ─────────────────────────────────────── */

function CurrentRunPanel({
  dashboard: d,
  branches,
  practiceLeft,
  officialLeft,
}: {
  dashboard: import("@shared/schema").Dashboard;
  branches: string[];
  practiceLeft: number;
  officialLeft: number;
}) {
  const startPractice = useStartPractice(DEFAULT_BENCHMARK);
  const promote = usePromote();
  const [branch, setBranch] = useState(d.team.repo?.defaultBranch ?? "main");

  const active = d.activeRun;

  if (active) {
    return (
      <Panel
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

  return (
    <Panel label="START A RUN">
      {/* Practice launch */}
      {practiceExhausted ? (
        <p className="text-[14px] text-ink">
          All {d.quota.practiceLimit} hosted practice runs are used. Local
          practice stays unlimited; a successful candidate can still be
          promoted below.
        </p>
      ) : (
        <>
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
          <p className="mt-3 font-mono text-[11px] text-ink-faint">
            {practiceLeft} of {d.quota.practiceLimit} hosted runs left
          </p>
        </>
      )}
      {startError && (
        <p role="alert" className="mt-3 text-[13px] text-detect-deep">
          {startError.code === "active_run_exists"
            ? "A run is already in progress — one at a time per benchmark."
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
              confirmLabel={`Confirm — uses attempt ${d.quota.officialUsed + 1} of ${OFFICIAL_LIMIT}`}
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
