import {
  ArrowDown01Icon,
  Copy01Icon,
  TeacherIcon,
  Tick02Icon,
  UserAdd01Icon,
  UserRemove01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { AdminTeamSummary } from "@cogworks/contracts/schema";
import { Button } from "@/components/Button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { EmptyState } from "@/components/EmptyState";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { Panel } from "@/components/Panel";
import { ApiRequestError } from "@/lib/api";
import { formatTimeAgo } from "@/lib/format";
import { EASE_OUT } from "@/lib/motion";
import {
  useAdminAddMember,
  useAdminAddStaff,
  useAdminAssignTa,
  useAdminOverview,
  useAdminPatchCohort,
  useAdminRemoveMember,
  useAdminRemoveStaff,
  useAdminRemoveTa,
  useAdminStaffRoster,
} from "@/lib/queries";

/**
 * The triage console. Ten TAs cannot read forty repositories, so this page
 * answers one question per row: has the platform run anything for this team
 * yet, and how much. TEAMS comes first because that is the question; the join
 * code, the roster, and the unassigned list are the owner's housekeeping and
 * sit below it.
 */
export function AdminPage() {
  const overview = useAdminOverview();

  if (overview.isPending) return <LoadingMark label="Loading cohort" />;
  if (overview.isError) {
    return (
      <div className="py-14">
        <QueryError error={overview.error} retry={() => void overview.refetch()} />
      </div>
    );
  }

  const { cohort, teams, unassigned } = overview.data;
  const isOwner = overview.data.scope === "owner";

  return (
    <div className="anim-rise mx-auto w-full max-w-2xl py-12">
      <p className="u-kicker">{isOwner ? "Admin" : "TA workspace"}</p>
      <h1 className="mt-1 text-3xl">{cohort.name}</h1>

      <Panel
        label="TEAMS"
        className="mt-8"
        aside={
          <span className="u-tnum font-mono text-[11px] text-ink-faint">
            {teams.length}
          </span>
        }
      >
        {teams.length === 0 ? (
          <EmptyState message="No teams yet." />
        ) : (
          <ul className="divide-y divide-rule-soft">
            {triageOrder(teams).map((team) => (
              <TeamRow key={team.id} team={team} canAssignTas={isOwner} />
            ))}
          </ul>
        )}
      </Panel>

      {isOwner ? <UnassignedPanel unassigned={unassigned} teams={teams} /> : null}

      {isOwner && cohort.joinCode ? (
        <CohortPanel cohort={{ ...cohort, joinCode: cohort.joinCode }} />
      ) : null}

      {isOwner ? <StaffPanel /> : null}
    </div>
  );
}

/* ── What a row says about a team ──────────────────────────────────────── */

function hostedRuns(team: AdminTeamSummary): number {
  return team.practiceUsed + team.officialUsed;
}

/**
 * The state phrase, which is the column a TA sweeps down.
 *
 * AdminTeamSummary (packages/contracts/src/schema.ts:1067) carries run counts
 * and no run timestamps, so the phrase can say how much has happened but not
 * when. "last run 2 h ago · failed at score" needs a last-run field on that
 * contract, and this lane may not add one; until it exists the honest phrase
 * is the count.
 */
function runState(team: AdminTeamSummary): string {
  const total = hostedRuns(team);
  if (total === 0) return "no hosted runs";
  return `${total} run${total === 1 ? "" : "s"}`;
}

/**
 * A team the platform has never run for is the row a TA has to act on, so it
 * sorts first. Aging the rest by their last run needs the field the contract
 * does not carry, so they stay alphabetical, which is at least an order a TA
 * can predict between visits.
 */
function triageOrder(teams: AdminTeamSummary[]): AdminTeamSummary[] {
  return [...teams].sort((left, right) => {
    const leftIdle = hostedRuns(left) === 0;
    const rightIdle = hostedRuns(right) === 0;
    if (leftIdle !== rightIdle) return leftIdle ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

/* ── Unassigned students ───────────────────────────────────────────────── */

/**
 * The panel holds the result of an assignment rather than the row, because a
 * successful add takes the student out of this list: the row that made the
 * request is unmounted before it could report anything.
 */
function UnassignedPanel({
  unassigned,
  teams,
}: {
  unassigned: { login: string; name: string | null; joinedAt: number | null }[];
  teams: AdminTeamSummary[];
}) {
  // seq remounts the line on every success, so a second assignment to the same
  // team is acknowledged rather than looking like the first one is still up.
  const [assigned, setAssigned] = useState<{ team: string; seq: number } | null>(null);
  const options = teams.map((team) => ({ id: team.id, name: team.name }));

  return (
    <Panel
      label="UNASSIGNED STUDENTS"
      className="mt-4"
      aside={
        <span className="u-tnum font-mono text-[11px] text-ink-faint">
          {unassigned.length}
        </span>
      }
    >
      {unassigned.length === 0 ? (
        <EmptyState message="Everyone in the cohort has a team." />
      ) : (
        <ul className="divide-y divide-rule-soft">
          {unassigned.map((student) => (
            <UnassignedRow
              key={student.login}
              student={student}
              teams={options}
              onAssigned={(team) =>
                setAssigned((prev) => ({ team, seq: (prev?.seq ?? 0) + 1 }))
              }
            />
          ))}
        </ul>
      )}
      {assigned ? (
        // The portal only claims what it can see, and the add response
        // (worker/routes/admin.ts:379) is the portal's own roster: it says
        // nothing about collaborator access on the fork, so this line does
        // not either.
        <p key={assigned.seq} role="status" className="anim-rise mt-3 text-[12.5px] text-ink-secondary">
          Added to {assigned.team}.
        </p>
      ) : null}
    </Panel>
  );
}

/* ── Platform staff roster (owner only) ────────────────────────────────── */

/**
 * The roster that decides who has staff access to the portal, editable here
 * so a cohort change does not need a redeploy. Owners are shown but not
 * editable: they come from the deployment's configuration on purpose, which
 * is what guarantees this panel can never lock every administrator out.
 *
 * Deliberately a plain list. An entry is an access grant, not a record of a
 * person, so there is nothing here to rank or score.
 */
function StaffPanel() {
  const roster = useAdminStaffRoster();
  const add = useAdminAddStaff();
  const remove = useAdminRemoveStaff();
  const [newLogin, setNewLogin] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLogin.trim() || add.isPending) return;
    add.mutate(newLogin.trim(), { onSuccess: () => setNewLogin("") });
  };

  return (
    <Panel
      label="PLATFORM STAFF"
      className="mt-4"
      aside={
        roster.data ? (
          <span className="u-tnum font-mono text-[11px] text-ink-faint">
            {roster.data.entries.length + roster.data.owners.length}
          </span>
        ) : null
      }
    >
      {roster.isPending ? (
        <LoadingMark label="Loading roster" />
      ) : roster.isError ? (
        <QueryError error={roster.error} retry={() => void roster.refetch()} />
      ) : (
        <>
          {roster.data.owners.length > 0 && (
            <ul className="divide-y divide-rule-soft border-b border-rule-soft">
              {roster.data.owners.map((login) => (
                <li key={login} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
                    {login}
                  </span>
                  <span
                    className="font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase"
                    title="Set in the deployment's configuration, so this panel cannot remove it."
                  >
                    owner
                  </span>
                </li>
              ))}
            </ul>
          )}

          {roster.data.entries.length === 0 ? (
            <EmptyState message="No staff added yet. Add a GitHub login below." />
          ) : (
            <ul className="divide-y divide-rule-soft">
              {roster.data.entries.map((entry) => (
                <li key={entry.login} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
                    {entry.login}
                    {entry.name ? (
                      <span className="ml-2 text-ink-faint">{entry.name}</span>
                    ) : (
                      // An entry is a login string, so a typo looks exactly
                      // like somebody who has not signed in yet. Saying which
                      // beats leaving an entry that quietly grants nothing.
                      <span
                        className="ml-2 text-ink-faint"
                        title="Nobody with this login has signed in. If the spelling is wrong, this grants nothing."
                      >
                        not signed in yet
                      </span>
                    )}
                  </span>
                  <span className="hidden font-mono text-[11px] text-ink-faint sm:inline">
                    added by {entry.grantedBy} {formatTimeAgo(entry.grantedAt)}
                  </span>
                  <button
                    type="button"
                    title={`Remove ${entry.login} from platform staff`}
                    onClick={() => remove.mutate(entry.login)}
                    disabled={remove.isPending}
                    className="u-pressable flex min-h-8 min-w-8 items-center justify-center text-ink-faint hover:text-detect-deep disabled:opacity-40"
                  >
                    <HugeiconsIcon icon={UserRemove01Icon} size={14} strokeWidth={1.8} aria-hidden="true" />
                    <span className="sr-only">Remove {entry.login} from platform staff</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={submit} className="mt-3 flex items-center gap-2">
            <label htmlFor="add-staff" className="sr-only">
              Add platform staff by GitHub login
            </label>
            <input
              id="add-staff"
              value={newLogin}
              onChange={(e) => setNewLogin(e.target.value)}
              placeholder="github login"
              spellCheck={false}
              className="h-9 min-w-0 flex-1 border border-rule bg-paper-sunken px-2.5 font-mono text-[12.5px] text-ink placeholder:text-ink-faint"
            />
            <button
              type="submit"
              disabled={!newLogin.trim() || add.isPending}
              className="u-pressable flex min-h-9 items-center gap-1.5 border border-rule px-3 font-mono text-[11px] tracking-[0.07em] text-ink-secondary uppercase hover:border-ink-secondary hover:text-ink disabled:opacity-40"
            >
              <HugeiconsIcon icon={UserAdd01Icon} size={13} strokeWidth={1.8} aria-hidden="true" />
              Add staff
            </button>
          </form>

          {(add.error || remove.error) && (
            <p role="alert" className="mt-2 text-[12.5px] text-detect-deep">
              {[add.error, remove.error]
                .filter((e): e is ApiRequestError => e instanceof ApiRequestError)
                .map((e) => e.message)
                .join(" ") || "The roster did not change. Try again."}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

/* ── Unassigned students: name, tenure, and a direct assignment ────────── */

function UnassignedRow({
  student,
  teams,
  onAssigned,
}: {
  student: { login: string; name: string | null; joinedAt: number | null };
  teams: { id: string; name: string }[];
  onAssigned: (teamName: string) => void;
}) {
  const add = useAdminAddMember();

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">
        {student.login}
        {student.name && <span className="ml-2 text-ink-faint">{student.name}</span>}
      </span>
      {student.joinedAt != null && (
        <span className="hidden font-mono text-[11px] text-ink-faint sm:inline">
          joined {formatTimeAgo(student.joinedAt)}
        </span>
      )}
      <span className="flex items-center gap-2">
        {add.error && (
          <span role="alert" className="text-[11px] text-detect-deep">
            {add.error instanceof ApiRequestError ? add.error.message : "Assigning failed."}
          </span>
        )}
        <select
          aria-label={`Assign ${student.login} to a team`}
          value=""
          disabled={add.isPending || teams.length === 0}
          onChange={(e) => {
            const team = teams.find((option) => option.id === e.target.value);
            if (!team) return;
            add.mutate(
              { teamId: team.id, login: student.login },
              { onSuccess: () => onAssigned(team.name) },
            );
          }}
          className="h-8 cursor-pointer border border-rule bg-paper-sunken px-2 font-mono text-[11px] tracking-[0.04em] text-ink-secondary uppercase transition-colors duration-150 hover:border-ink-secondary hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="" disabled>
            {add.isPending ? "Assigning…" : "Assign to team…"}
          </option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </span>
    </li>
  );
}

/* ── Cohort: join code + enrollment ────────────────────────────────────── */

function CohortPanel({
  cohort,
}: {
  cohort: { slug: string; name: string; joinCode: string; active: boolean };
}) {
  const patch = useAdminPatchCohort();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copying = useRef(false);
  const copied = copyStatus === "copied";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    // Keep the button focusable while suppressing overlapping writes.
    if (copying.current) return;
    copying.current = true;
    if (timer.current) clearTimeout(timer.current);
    setCopyStatus("idle");
    try {
      await navigator.clipboard.writeText(cohort.joinCode);
      setCopyStatus("copied");
      timer.current = setTimeout(() => setCopyStatus("idle"), 1400);
    } catch {
      setCopyStatus("failed");
    } finally {
      copying.current = false;
    }
  };

  return (
    <Panel
      label="COHORT"
      className="mt-8"
      aside={
        <span
          className={`font-mono text-[10.5px] tracking-[0.08em] uppercase ${
            cohort.active ? "text-verify-deep" : "text-detect-deep"
          }`}
        >
          {cohort.active ? "enrollment open" : "enrollment closed"}
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="u-kicker">Join code</div>
        <button
          type="button"
          onClick={copy}
          title="Copy join code"
          aria-label={`Copy join code ${cohort.joinCode}`}
          className="u-pressable inline-flex min-h-9 items-center gap-2 border border-rule bg-paper-sunken px-3 font-mono text-[15px] tracking-[0.25em] text-ink hover:border-ink-secondary"
        >
          <span className="select-text">{cohort.joinCode}</span>
          <HugeiconsIcon
            icon={copied ? Tick02Icon : Copy01Icon}
            size={13}
            strokeWidth={1.8}
            className={copied ? "text-verify" : "text-ink-faint"}
            aria-hidden="true"
          />
        </button>
      </div>
      <p role="status" className={copyStatus === "failed" ? "mt-2 text-[13px] text-detect-deep" : "sr-only"}>
        {copyStatus === "failed" ? "Couldn't copy. Select the join code above and copy it manually, or try again." : copied ? "Copied." : ""}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-rule-soft pt-4">
        <ConfirmButton
          variant="primary"
          label="Rotate join code"
          confirmLabel="Confirm, the old code stops working"
          onConfirm={() => patch.mutate({ rotateJoinCode: true })}
          busy={patch.isPending}
        />
        <Button
          variant="ghost"
          onClick={() => patch.mutate({ active: !cohort.active })}
          busy={patch.isPending}
        >
          {cohort.active ? "Close enrollment" : "Open enrollment"}
        </Button>
      </div>
      {patch.error && (
        <p role="alert" className="mt-3 text-[13px] text-detect-deep">
          {patch.error instanceof ApiRequestError ? patch.error.message : "Update failed."}
        </p>
      )}
    </Panel>
  );
}

/* ── Team row with expandable members ──────────────────────────────────── */

function TeamRow({ team, canAssignTas }: { team: AdminTeamSummary; canAssignTas: boolean }) {
  const [open, setOpen] = useState(false);
  const [newLogin, setNewLogin] = useState("");
  const [newTaLogin, setNewTaLogin] = useState("");
  const reduce = useReducedMotion();
  const addMember = useAdminAddMember();
  const removeMember = useAdminRemoveMember();
  const assignTa = useAdminAssignTa();
  const removeTa = useAdminRemoveTa();

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLogin.trim() || addMember.isPending) return;
    addMember.mutate(
      { teamId: team.id, login: newLogin.trim() },
      { onSuccess: () => setNewLogin("") },
    );
  };

  const addTa = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaLogin.trim() || assignTa.isPending) return;
    assignTa.mutate(
      { teamId: team.id, login: newTaLogin.trim() },
      { onSuccess: () => setNewTaLogin("") },
    );
  };

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`team-${team.id}`}
        onClick={() => setOpen((v) => !v)}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto_1.5rem] items-baseline gap-x-4 py-2.5 text-left hover:bg-paper-sunken/50"
      >
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-medium text-ink" title={team.name}>
            {team.name}
          </span>
          <span className="block truncate font-mono text-[11px] text-ink-faint">
            {team.repoFullName}
          </span>
        </span>
        {/* The column a TA sweeps. Full ink on a team the platform has never
            run for, faint on the rest, so forty rows resolve to the handful
            worth opening without reading a single number. */}
        <span
          className={`font-mono text-[11px] ${
            hostedRuns(team) === 0 ? "text-ink" : "text-ink-faint"
          }`}
        >
          {runState(team)}
        </span>
        <span className="u-tnum font-mono text-[11px] text-ink-secondary">
          {/* Totals span benchmark versions, so a single version's quota is not a denominator. */}
          {team.practiceUsed} practice runs · {team.officialUsed} official attempts
          {/* Only when there are any. A team that keeps hitting real
              infrastructure trouble and a team whose submission provokes the
              same platform-side failure both show up here, and both are worth
              looking at; a "0 refunded" on every other row would bury that. */}
          {team.refundsGiven > 0 ? (
            <span title="Official attempts given back after a run failed on the platform's side.">
              {" · "}
              {team.refundsGiven} refunded
            </span>
          ) : null}
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: open ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.15, ease: "easeOut" }}
          className="justify-self-end self-center text-ink-faint"
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.8} />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`team-${team.id}`}
            initial={reduce ? { opacity: 1, height: "auto" } : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={
              reduce
                ? { opacity: 0, transition: { duration: 0 } }
                : { height: 0, opacity: 0, transition: { duration: 0.16, ease: "easeOut" } }
            }
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="pb-3 pl-1">
              <div className="mb-3 border-b border-rule-soft pb-3">
                <p className="u-kicker mb-1.5">Assigned teaching staff</p>
                {team.tas.length > 0 ? (
                  <ul>
                    {team.tas.map((ta) => (
                      <li key={ta.login} className="flex items-center gap-3 py-1.5">
                        <HugeiconsIcon icon={TeacherIcon} size={14} strokeWidth={1.8} className="text-verify-deep" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
                          {ta.login}
                          {ta.name ? <span className="ml-2 text-ink-faint">{ta.name}</span> : null}
                        </span>
                        {canAssignTas ? (
                          <button
                            type="button"
                            title={`Remove ${ta.login} as TA for ${team.name}`}
                            onClick={() => removeTa.mutate({ teamId: team.id, login: ta.login })}
                            disabled={removeTa.isPending}
                            className="u-pressable flex min-h-8 min-w-8 items-center justify-center text-ink-faint hover:text-detect-deep disabled:opacity-40"
                          >
                            <HugeiconsIcon icon={UserRemove01Icon} size={14} strokeWidth={1.8} aria-hidden="true" />
                            <span className="sr-only">Remove {ta.login} as TA</span>
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-1 font-mono text-[11.5px] text-ink-faint">No TA assigned.</p>
                )}
                {canAssignTas ? (
                  <form onSubmit={addTa} className="mt-2 flex items-center gap-2">
                    <label htmlFor={`add-ta-${team.id}`} className="sr-only">
                      Assign TA by GitHub login
                    </label>
                    <input
                      id={`add-ta-${team.id}`}
                      value={newTaLogin}
                      onChange={(e) => setNewTaLogin(e.target.value)}
                      placeholder="TA github login"
                      spellCheck={false}
                      className="h-9 min-w-0 flex-1 border border-rule bg-paper-sunken px-2.5 font-mono text-[12.5px] text-ink placeholder:text-ink-faint"
                    />
                    <button
                      type="submit"
                      disabled={!newTaLogin.trim() || assignTa.isPending}
                      className="u-pressable flex min-h-9 items-center gap-1.5 border border-rule px-3 font-mono text-[11px] tracking-[0.07em] text-ink-secondary uppercase hover:border-ink-secondary hover:text-ink disabled:opacity-40"
                    >
                      <HugeiconsIcon icon={TeacherIcon} size={13} strokeWidth={1.8} aria-hidden="true" />
                      Assign TA
                    </button>
                  </form>
                ) : null}
              </div>
              <ul className="divide-y divide-rule-soft">
                {team.members.map((m) => (
                  <li key={m.login} className="flex items-center gap-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
                      {m.login}
                      {m.name && <span className="ml-2 text-ink-faint">{m.name}</span>}
                    </span>
                    <span
                      className={`font-mono text-[10px] tracking-[0.08em] uppercase ${
                        m.role === "admin" ? "text-detect-deep" : "text-ink-faint"
                      }`}
                    >
                      {m.role === "admin" ? "creator" : m.role === "maintain" ? "maintainer" : "member"}
                    </span>
                    <button
                      type="button"
                      title={`Remove ${m.login} from ${team.name}`}
                      onClick={() => removeMember.mutate({ teamId: team.id, login: m.login })}
                      disabled={removeMember.isPending}
                      className="u-pressable flex min-h-8 min-w-8 items-center justify-center text-ink-faint hover:text-detect-deep disabled:opacity-40"
                    >
                      <HugeiconsIcon icon={UserRemove01Icon} size={14} strokeWidth={1.8} aria-hidden="true" />
                      <span className="sr-only">Remove {m.login}</span>
                    </button>
                  </li>
                ))}
              </ul>

              <form onSubmit={add} className="mt-2 flex items-center gap-2">
                <label htmlFor={`add-${team.id}`} className="sr-only">
                  Add member by GitHub login
                </label>
                <input
                  id={`add-${team.id}`}
                  value={newLogin}
                  onChange={(e) => setNewLogin(e.target.value)}
                  placeholder="github login"
                  spellCheck={false}
                  className="h-9 min-w-0 flex-1 border border-rule bg-paper-sunken px-2.5 font-mono text-[12.5px] text-ink placeholder:text-ink-faint"
                />
                <button
                  type="submit"
                  disabled={!newLogin.trim() || addMember.isPending}
                  className="u-pressable flex min-h-9 items-center gap-1.5 border border-rule px-3 font-mono text-[11px] tracking-[0.07em] text-ink-secondary uppercase hover:border-ink-secondary hover:text-ink disabled:opacity-40"
                >
                  <HugeiconsIcon icon={UserAdd01Icon} size={13} strokeWidth={1.8} aria-hidden="true" />
                  Add
                </button>
              </form>
              {(addMember.error || removeMember.error || assignTa.error || removeTa.error) && (
                <p role="alert" className="mt-2 text-[12.5px] text-detect-deep">
                  {[addMember.error, removeMember.error, assignTa.error, removeTa.error]
                    .filter((e): e is ApiRequestError => e instanceof ApiRequestError)
                    .map((e) => e.message)
                    .join(" ") || "Member update failed."}
                </p>
              )}

              {/* The score is the leaderboard's business, not triage's: it
                  told a TA nothing about which team to open, and it took the
                  row's widest column to say it. Down here it is a footnote on
                  the team already being read. */}
              <p className="u-tnum mt-3 border-t border-rule-soft pt-2 font-mono text-[11px] text-ink-faint">
                {team.published
                  ? `Latest published score ${team.published.score.toFixed(3)} · ${team.published.benchmarkName ?? "benchmark not in the catalog"} v${team.published.benchmarkVersion}`
                  : "Nothing published yet"}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}
