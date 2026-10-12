import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { FAILURE_CATALOG } from "@cogworks/contracts/failures";
import type {
  StaffDeskHistoryState,
  StaffDeskRunRow,
  StaffDeskTeamRow,
  StaffView,
} from "@cogworks/contracts/schema";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { Note, PageHeader } from "@/components/Note";
import { PageSection } from "@/components/PageSection";
import { StatusChip } from "@/components/StatusChip";
import { formatDate, formatTimeAgo, isoDate } from "@/lib/format";
import { useStaffDeskRuns, useStaffDeskTeam, useStaffDeskTeams } from "@/lib/queries";
import { PHASE_LABELS } from "@/lib/run-meta";

/**
 * The staff process desk: what the portal has already observed about each
 * assigned team, its runs and the last stored read of its commit history.
 *
 * Nothing here fetches from GitHub (worker/routes/staff-desk.ts), so the
 * history is reported with its age and source rather than refreshed, and a
 * read that is missing, unreadable or of another branch says so instead of
 * standing in for the team's current work. Two pages, one decision each:
 * the list is "which team do I open", the team page is "what has it done".
 */

const WEEK_NAMES = { week1: "Week 1 · Audio", week2: "Week 2 · Vision", week3: "Week 3 · Language" } as const;

/** One sentence per history state, in the margin voice. */
function historySentence(history: StaffDeskHistoryState, branch: string): string {
  switch (history.status) {
    case "never_read":
      return "Nobody on this team has opened their Team page yet, so the portal has no read of their commits to show.";
    case "unreadable":
      return "The stored read of their commits couldn't be used, so nothing from it is shown. The next visit to their Team page replaces it.";
    case "other_repository":
      return "The last read was of a repository this team has since left, so it isn't shown as theirs.";
    case "other_branch":
      return `The last read was of a branch other than ${branch}, so it isn't shown as this branch's work.`;
    case "stale":
      return `Read ${formatTimeAgo(history.checkedAt ?? 0)} from ${branch}. That's older than the half hour the Team page keeps a read; the next visit to their Team page refreshes it.`;
    case "fresh":
      return `Read ${formatTimeAgo(history.checkedAt ?? 0)} from ${branch}, when someone on the team last opened their Team page.`;
  }
}

/** The list row's short form of the same state. */
function historyShort(history: StaffDeskHistoryState): string {
  switch (history.status) {
    case "never_read":
      return "History not read yet";
    case "unreadable":
      return "History unreadable";
    case "other_repository":
      return "History is of another repository";
    case "other_branch":
      return "History is of another branch";
    case "stale":
    case "fresh":
      return `History read ${formatTimeAgo(history.checkedAt ?? 0)}`;
  }
}

function RestrictedNote({ view }: { view: StaffView }) {
  if (view !== "restricted") return null;
  return (
    <Note className="mt-6 max-w-[38rem]">
      This portal runs the restricted staff setting, so student names, scores and process findings are withheld
      here. Team counts, run states and failure categories stay.
    </Note>
  );
}

/** A team with no scored run is the one to open first; then by name. */
function deskOrder(teams: StaffDeskTeamRow[]): StaffDeskTeamRow[] {
  return [...teams].sort(
    (left, right) =>
      Number(left.firstLight !== null) - Number(right.firstLight !== null) || left.name.localeCompare(right.name),
  );
}

function ProgressLine({ team }: { team: StaffDeskTeamRow }) {
  if (team.firstLight) {
    return (
      <span className="block text-[13.5px] text-ink-secondary">
        First scored run{" "}
        <time dateTime={isoDate(team.firstLight.at)}>{formatDate(team.firstLight.at)}</time>
        {team.scoredRunCount > 1 ? ` · ${team.scoredRunCount} scored` : ""}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-detect" />
      {team.runsElsewhere ? "Scored only from another repository" : "No scored run yet"}
    </span>
  );
}

export function StaffDeskPage() {
  const desk = useStaffDeskTeams();
  if (desk.isPending) return <LoadingMark label="Loading the desk" />;
  if (desk.isError) {
    return (
      <div className="page">
        <QueryError error={desk.error} retry={() => void desk.refetch()} />
      </div>
    );
  }
  const { teams, scope, view } = desk.data;
  return (
    <div className="page anim-rise">
      <PageHeader
        eyebrow="Process desk"
        title="Where each team's work stands"
        lede="Runs and the last read of each team's commits, as the portal already has them. Opening this reads nothing from GitHub, so it costs a team nothing."
      />
      <RestrictedNote view={view} />
      <PageSection
        id="desk-teams"
        title={scope === "owner" ? "All teams" : "Your teams"}
        aside={<span className="u-tnum font-mono text-[13px] text-ink-faint">{teams.length}</span>}
        note="Teams without a scored run come first. Those are the ones worth a word this week."
      >
        {teams.length === 0 ? (
          <EmptyState
            message={
              scope === "owner"
                ? "No live teams yet. They appear here once students connect a repository."
                : "No teams are assigned to you yet. An owner assigns TAs on the Admin page."
            }
          />
        ) : (
          <ul className="overflow-hidden rounded-surface border border-rule bg-paper-raised">
            {deskOrder(teams).map((team) => (
              <li key={team.id} className="border-b border-rule-soft last:border-b-0">
                <Link
                  to={`/desk/${encodeURIComponent(team.id)}`}
                  className="grid min-h-16 grid-cols-1 gap-x-5 gap-y-1 px-4 py-3 transition-colors duration-150 hover:bg-paper-sunken/60 focus-visible:outline-offset-[-3px] sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[15.5px] font-semibold text-ink" title={team.name}>
                      {team.name}
                    </span>
                    <span className="block truncate font-mono text-[12.5px] text-ink-faint">{team.repo.fullName}</span>
                  </span>
                  <span className="min-w-0 sm:max-w-[16rem] sm:text-right">
                    <ProgressLine team={team} />
                    <span className="block truncate text-[13px] text-ink-faint">
                      {team.weekLabel ? `${WEEK_NAMES[team.weekLabel]} · ` : ""}
                      {historyShort(team.history)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageSection>
    </div>
  );
}

function activityWords(row: StaffDeskRunRow): string | null {
  if (row.activity === "stale") return "No word from the runner for longer than its limit";
  return null;
}

function evidenceWords(row: StaffDeskRunRow): string | null {
  if (row.evidence === "elsewhere") return `From ${row.repositoryFullName ?? "another repository"}`;
  if (row.evidence === "unrecorded") return "Repository not recorded";
  return null;
}

function RunRow({ row }: { row: StaffDeskRunRow }) {
  const failure =
    row.failurePhase && row.failureCategory
      ? `Stopped at ${PHASE_LABELS[row.failurePhase]} · ${FAILURE_CATALOG[row.failureCategory].code}`
      : null;
  const notes = [failure, activityWords(row), evidenceWords(row)].filter(Boolean);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 py-3">
      <span className="min-w-0">
        <span className="block truncate text-[14.5px] font-semibold text-ink">
          {row.benchmarkTitle}
          <span className="font-normal text-ink-secondary">
            {" "}
            · {row.mode === "official" ? `official${row.attemptNumber ? ` #${row.attemptNumber}` : ""}` : "practice"}
          </span>
        </span>
        {notes.length > 0 && <span className="block text-[13px] text-ink-secondary">{notes.join(". ")}</span>}
      </span>
      <span className="flex flex-col items-end gap-0.5">
        <StatusChip status={row.status} />
        <time className="u-tnum text-[12.5px] text-ink-faint" dateTime={new Date(row.createdAt).toISOString()}>
          {formatTimeAgo(row.createdAt)}
        </time>
      </span>
    </li>
  );
}

/** Keyed by team where it is rendered, so another team opens on its first page. */
function RunsSection({ teamId }: { teamId: string }) {
  const [page, setPage] = useState(1);
  const runs = useStaffDeskRuns(teamId, page);
  // Runs can disappear between pages (a cached later page, a reset team), and
  // an empty page past the end has no "Older" to leave by. Step back to the
  // last page that has rows.
  const lastPage = runs.data ? Math.max(1, Math.ceil(runs.data.total / runs.data.pageSize)) : null;
  useEffect(() => {
    if (lastPage !== null && !runs.isPlaceholderData && page > lastPage) setPage(lastPage);
  }, [lastPage, page, runs.isPlaceholderData]);
  return (
    <PageSection
      id="desk-runs"
      title="Runs"
      aside={runs.data ? <span className="u-tnum font-mono text-[13px] text-ink-faint">{runs.data.total}</span> : null}
      note="States, clocks and failure categories only. A run's log and its own error text stay with the team."
    >
      {runs.isPending ? (
        <LoadingMark label="Loading runs" />
      ) : runs.isError ? (
        <QueryError error={runs.error} retry={() => void runs.refetch()} />
      ) : runs.data.runs.length === 0 ? (
        <EmptyState message="This team hasn't started a hosted run yet." />
      ) : (
        <>
          <ul className="divide-y divide-rule-soft" aria-busy={runs.isPlaceholderData}>
            {runs.data.runs.map((row) => (
              <RunRow key={row.runId} row={row} />
            ))}
          </ul>
          {(page > 1 || runs.data.hasMore) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {page > 1 && (
                <Button variant="quiet" onClick={() => setPage((current) => current - 1)}>
                  Newer runs
                </Button>
              )}
              {runs.data.hasMore && (
                <Button variant="ghost" busy={runs.isPlaceholderData} onClick={() => setPage((current) => current + 1)}>
                  Older runs
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </PageSection>
  );
}

export function StaffDeskTeamPage() {
  const { teamId = "" } = useParams();
  const desk = useStaffDeskTeam(teamId);
  const back = (
    <Link to="/desk" className="inline-flex min-h-11 items-center text-[14px] font-semibold text-ink-secondary hover:text-ink">
      All teams
    </Link>
  );
  if (desk.isPending) return <LoadingMark label="Loading the team" />;
  if (desk.isError) {
    return (
      <div className="page">
        {back}
        <QueryError error={desk.error} retry={() => void desk.refetch()} />
      </div>
    );
  }
  const { team, history, commitSignals, view, weekLabel, firstLight, runsElsewhere } = desk.data;
  const branch = team.repo.defaultBranch;
  return (
    <div className="page anim-rise">
      <nav aria-label="Desk">{back}</nav>
      <PageHeader
        className="mt-2"
        eyebrow={weekLabel ? `Process desk · ${WEEK_NAMES[weekLabel]}` : "Process desk"}
        title={team.name}
        lede={
          <>
            <span className="font-mono text-[14px]">{team.repo.fullName}</span> on{" "}
            <span className="font-mono text-[14px]">{branch}</span>
            {". "}
            {firstLight
              ? `First scored run ${formatDate(firstLight.at)}, on ${firstLight.benchmarkTitle}.`
              : runsElsewhere
                ? "Its scored runs are all from another repository."
                : "No run from this repository has scored yet."}
          </>
        }
      />
      <RestrictedNote view={view} />

      <PageSection id="desk-history" title="What the commits show" note={historySentence(history, branch)}>
        {view === "restricted" ? (
          <p className="text-[15px] text-ink-secondary">Process findings are withheld under the restricted staff setting.</p>
        ) : commitSignals && commitSignals.findingSentences.length > 0 ? (
          <ul className="space-y-3">
            {commitSignals.findingSentences.map((sentence) => (
              <li key={sentence} className="max-w-[38rem] font-serif text-[17px] leading-[1.5] text-ink">
                {sentence}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[15px] text-ink-secondary">
            {history.forConnectedRepository
              ? "The read has no finding to report yet."
              : "Nothing to report until there's a read of this repository and branch."}
          </p>
        )}
      </PageSection>

      <RunsSection key={team.id} teamId={team.id} />

      <PageSection id="desk-people" title="People">
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          <div className="min-w-0">
            <h3 className="u-label">Members</h3>
            {view === "restricted" ? (
              <p className="mt-1.5 text-[14px] text-ink-secondary">
                {team.memberCount} {team.memberCount === 1 ? "student" : "students"}. Names are withheld.
              </p>
            ) : team.members.length === 0 ? (
              <p className="mt-1.5 text-[14px] text-ink-secondary">Nobody is on this team.</p>
            ) : (
              <ul className="mt-1 divide-y divide-rule-soft">
                {team.members.map((member) => (
                  <li key={member.login} className="flex min-h-11 items-center justify-between gap-3 py-1">
                    <span className="truncate font-mono text-[13.5px] text-ink">{member.login}</span>
                    {member.role === "admin" && <span className="text-[13px] font-semibold text-ink-secondary">Admin</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="min-w-0">
            <h3 className="u-label">Teaching staff</h3>
            {team.tas.length === 0 ? (
              <p className="mt-1.5 text-[14px] text-ink-secondary">No TA assigned.</p>
            ) : (
              <ul className="mt-1 divide-y divide-rule-soft">
                {team.tas.map((ta) => (
                  <li key={ta.login} className="flex min-h-11 items-center py-1 font-mono text-[13.5px] text-ink">
                    {ta.login}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </PageSection>
    </div>
  );
}
