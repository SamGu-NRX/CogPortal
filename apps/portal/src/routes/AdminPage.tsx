import { ArrowDown01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import type { AdminTeamSummary } from "@cogworks/contracts/schema";
import { CornerBrackets } from "@/components/Brackets";
import { Button } from "@/components/Button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { MemberAvatar } from "@/components/MemberAvatar";
import { PageHeader } from "@/components/Note";
import { PageSection } from "@/components/PageSection";
import { RemoveButton } from "@/components/RemoveButton";
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
 * yet, and how much. Teams come first because that is the question; the
 * unassigned list and the staff roster are the owner's housekeeping and sit
 * below it.
 *
 * The join code is the exception, and sits above the teams for an owner: it is
 * the one thing on this page an instructor reads aloud or puts on a projector,
 * so it is set large and found without scrolling. It is a strip, not a
 * section, so the teams are still the first list on the page.
 */
export function AdminPage() {
  const overview = useAdminOverview();

  if (overview.isPending) return <LoadingMark label="Loading cohort" />;
  if (overview.isError) {
    return (
      <div className="page">
        <QueryError error={overview.error} retry={() => void overview.refetch()} />
      </div>
    );
  }

  const { cohort, teams, unassigned } = overview.data;
  const isOwner = overview.data.scope === "owner";

  return (
    <div className="page anim-rise">
      <PageHeader
        eyebrow={isOwner ? "Instructor console" : "TA workspace"}
        title={cohort.name}
        lede={
          isOwner
            ? "Open a team to see who's on it and what it last published."
            : "The teams assigned to you. Open one to see who's on it and to add or remove a student."
        }
      />

      {isOwner && cohort.joinCode ? (
        <Enrollment cohort={{ ...cohort, joinCode: cohort.joinCode }} />
      ) : null}

      <PageSection
        id="admin-teams"
        title="Teams"
        aside={<Count n={teams.length} />}
        note="A team the platform has never run anything for sorts first, since it's the one worth opening."
      >
        {teams.length === 0 ? (
          // Staff sees assigned teams only.
          <p className="text-[15px] text-ink-secondary">
            {isOwner ? "No teams yet." : "No teams assigned to you yet."}
          </p>
        ) : (
          <ul className="overflow-hidden rounded-surface border border-rule bg-paper-raised">
            {triageOrder(teams).map((team) => (
              <TeamRow
                key={team.id}
                team={team}
                canAssignTas={isOwner}
                suggestions={unassigned.map((student) => student.login)}
              />
            ))}
          </ul>
        )}
      </PageSection>

      {isOwner ? <UnassignedSection unassigned={unassigned} teams={teams} /> : null}

      {isOwner ? <StaffSection /> : null}
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="u-tnum font-mono text-[13px] text-ink-faint">{n}</span>;
}

function hostedRuns(team: AdminTeamSummary): number {
  return team.practiceUsed + team.officialUsed;
}

/**
 * A team the platform has never run for is the row a TA has to act on, so it
 * sorts first. Aging the rest by their last run needs a last-run field that
 * AdminTeamSummary (packages/contracts/src/schema.ts) does not carry, so they
 * stay alphabetical.
 */
function triageOrder(teams: AdminTeamSummary[]): AdminTeamSummary[] {
  return [...teams].sort((left, right) => {
    const leftIdle = hostedRuns(left) === 0;
    const rightIdle = hostedRuns(right) === 0;
    if (leftIdle !== rightIdle) return leftIdle ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

/* ── Enrollment: the join code, large enough to read off a projector ───── */

function Enrollment({
  cohort,
}: {
  cohort: { slug: string; name: string; joinCode: string; active: boolean };
}) {
  const patch = useAdminPatchCohort();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copying = useRef(false);
  const copied = copyStatus === "copied";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [changing, setChanging] = useState(false);
  const [rotated, setRotated] = useState(0);
  const foldRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const foldId = useId();
  const titleId = useId();

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
    <section
      aria-labelledby={titleId}
      className="mt-9 rounded-surface border border-rule bg-paper-raised lg:max-w-[42rem]"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 px-5 pt-4 pb-5 sm:px-6">
        <div className="min-w-0">
          <h2 id={titleId} className="u-label">
            Join code
          </h2>
          <button
            type="button"
            onClick={copy}
            title="Copy join code"
            aria-label={`Copy join code ${cohort.joinCode}`}
            className="u-pressable group relative mt-3 inline-flex items-center gap-4 rounded-control px-3 py-2"
          >
            {/* The detection bracket: the one thing on this page to look at. */}
            <CornerBrackets size={12} thickness={1.5} className="text-ink/45 transition-colors duration-150 group-hover:text-ink" />
            <span className="select-text font-mono text-[clamp(2.25rem,1.5rem+3vw,3.25rem)] leading-none font-medium tracking-[0.12em] text-ink">
              {cohort.joinCode}
            </span>
            <span
              aria-hidden="true"
              className={`inline-flex items-center gap-1.5 text-[13.5px] font-semibold ${
                copied ? "text-verify-deep" : "text-ink-secondary group-hover:text-ink"
              }`}
            >
              <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={15} strokeWidth={1.8} />
              {copied ? "Copied" : "Copy"}
            </span>
          </button>
          <p
            role="status"
            className={copyStatus === "failed" ? "mt-2 text-[14px] text-detect-deep" : "sr-only"}
          >
            {copyStatus === "failed"
              ? "Couldn't copy. Select the join code above and copy it manually, or try again."
              : copied
                ? "Copied."
                : ""}
          </p>
        </div>

        <div className="max-w-[16rem]">
          <p className="flex items-center gap-2 text-[14.5px] font-semibold text-ink">
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${cohort.active ? "bg-verify" : "bg-detect"}`}
            />
            {cohort.active ? "Enrollment open" : "Enrollment closed"}
          </p>
          <p className="mt-0.5 text-[13.5px] leading-snug text-ink-secondary">
            {cohort.active
              ? "Anyone with this code can join the cohort."
              : "The code is refused until you open enrollment again."}
          </p>
        </div>
      </div>

      <div className="border-t border-rule-soft px-3 sm:px-4">
        <button
          type="button"
          aria-expanded={changing}
          aria-controls={foldId}
          onClick={(event) => {
            // Safari doesn't focus a clicked button, so focus can still be on
            // an action inside the fold; going inert would drop it to the body.
            if (changing && foldRef.current?.contains(document.activeElement)) {
              event.currentTarget.focus();
            }
            setChanging(!changing);
          }}
          className="u-pressable inline-flex min-h-11 items-center gap-1.5 rounded-control px-2 text-[14px] font-semibold text-ink-secondary transition-colors duration-150 hover:text-ink"
        >
          Change enrollment
          <motion.span
            aria-hidden="true"
            animate={{ rotate: changing ? 180 : 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT }}
            className="inline-flex"
          >
            <HugeiconsIcon icon={ArrowDown01Icon} size={15} strokeWidth={1.8} />
          </motion.span>
        </button>
        {/* Rotating never changes whether enrollment is open, so what the new
            code does is read from the cohort as it is now, including after
            enrollment is opened or closed later. */}
        {rotated > 0 && (
          <p key={rotated} role="status" className="anim-rise px-2 pb-3 text-[14px] text-ink">
            {cohort.active
              ? "The new code works now, and the old one no longer does."
              : "The old code no longer works. The new one will once you open enrollment."}
          </p>
        )}
        {/* The wrapper stays mounted, so these flip the moment the fold
            closes; the actions inside are still on screen for the exit
            animation and must not take focus or be read out meanwhile. Only
            the toggle closes the fold, and it takes focus back first. */}
        <div ref={foldRef} id={foldId} inert={!changing} aria-hidden={!changing}>
          <AnimatePresence initial={false}>
            {changing && (
              <motion.div
                initial={reduce ? { opacity: 1, height: "auto" } : { height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={
                  reduce
                    ? { opacity: 0, transition: { duration: 0 } }
                    : { height: 0, opacity: 0, transition: { duration: 0.16, ease: EASE_OUT } }
                }
                transition={{ duration: 0.22, ease: EASE_OUT }}
                className="overflow-hidden"
              >
                <div className="space-y-4 px-2 pt-1 pb-5">
                  <EnrollmentAction
                    action={
                      <Button
                        variant="ghost"
                        onClick={() => patch.mutate({ active: !cohort.active })}
                        busy={patch.isPending}
                      >
                        {cohort.active ? "Close enrollment" : "Open enrollment"}
                      </Button>
                    }
                  >
                    {cohort.active
                      ? "New students can't join until you open it again. Everyone already in the cohort keeps their place."
                      : "Anyone with the code can join again."}
                  </EnrollmentAction>
                  <EnrollmentAction
                    action={
                      <ConfirmButton
                        variant="official"
                        label="Rotate join code"
                        confirmLabel="Confirm, the old code stops working"
                        onConfirm={() =>
                          patch.mutate(
                            { rotateJoinCode: true },
                            { onSuccess: () => setRotated((n) => n + 1) },
                          )
                        }
                        busy={patch.isPending}
                      />
                    }
                  >
                    Makes a new code at once. Use it if this one reached people outside the
                    course.
                  </EnrollmentAction>
                  {patch.error && (
                    <p role="alert" className="text-[14px] text-detect-deep">
                      {patch.error instanceof ApiRequestError
                        ? patch.error.message
                        : "Enrollment didn't change. Try again in a moment."}
                    </p>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}

function EnrollmentAction({ action, children }: { action: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-5 gap-y-2 sm:grid-cols-[13.5rem_minmax(0,1fr)] sm:items-center">
      <div>{action}</div>
      <p className="text-[14px] leading-snug text-ink-secondary">{children}</p>
    </div>
  );
}

/* ── Teams: one row each, opening to people and the published result ───── */

/** A person on a roster line: face, name, and login when the name differs. */
function Person({ login, name, avatarUrl = null }: { login: string; name: string | null; avatarUrl?: string | null }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5">
      <MemberAvatar login={login} avatarUrl={avatarUrl} size={24} />
      <span className="min-w-0">
        <span className="block truncate text-[14.5px] font-semibold text-ink">{name ?? login}</span>
        {name && name !== login && (
          <span className="block truncate font-mono text-[12px] text-ink-faint">{login}</span>
        )}
      </span>
    </span>
  );
}

/** Add someone by GitHub login: the two rosters in a team row and the staff roster. */
function LoginForm({
  id,
  label,
  submit,
  busy,
  suggestions,
  onSubmit,
}: {
  id: string;
  label: string;
  submit: string;
  busy: boolean;
  /** Logins offered as the field is typed in (the cohort's unassigned students). */
  suggestions?: string[];
  /** Resolves true when the login was added, which is when the field clears. */
  onSubmit: (login: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const listId = `${id}-suggestions`;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim() || busy) return;
        void onSubmit(value.trim()).then((added) => {
          if (added) setValue("");
        });
      }}
      className="mt-3"
    >
      <label htmlFor={id} className="u-label">
        {label}
      </label>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          id={id}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="GitHub login"
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          list={suggestions && suggestions.length > 0 ? listId : undefined}
          className="u-field min-w-0 flex-1 font-mono placeholder:font-sans"
        />
        <Button type="submit" variant="ghost" busy={busy} disabled={!value.trim()}>
          {submit}
        </Button>
      </div>
      {suggestions && suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((login) => (
            <option key={login} value={login} />
          ))}
        </datalist>
      )}
    </form>
  );
}

function errorText(errors: unknown[], fallback: string): string | null {
  const present = errors.filter(Boolean);
  if (present.length === 0) return null;
  const said = present.filter((e): e is ApiRequestError => e instanceof ApiRequestError);
  return said.length > 0 ? said.map((e) => e.message).join(" ") : fallback;
}

function TeamRow({
  team,
  canAssignTas,
  suggestions,
}: {
  team: AdminTeamSummary;
  canAssignTas: boolean;
  suggestions: string[];
}) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  const addMember = useAdminAddMember();
  const removeMember = useAdminRemoveMember();
  const assignTa = useAdminAssignTa();
  const removeTa = useAdminRemoveTa();
  const idle = hostedRuns(team) === 0;
  const detailsId = `team-${team.id}`;
  // A removed row takes its focused control with it; the row's own toggle is
  // the nearest stable place to put focus back.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const refocus = () => toggleRef.current?.focus();

  const memberError = errorText(
    [addMember.error, removeMember.error],
    "The member list didn't change. Try again.",
  );
  const taError = errorText([assignTa.error, removeTa.error], "The TA list didn't change. Try again.");

  return (
    <li className="border-b border-rule-soft last:border-b-0">
      {/* On phones the auto-sized count columns consumed the identity column.
          Put the run state and TAs below identity until `sm:`. The focus ring
          is drawn inside the row, because the list's rounded frame clips
          anything outside it. */}
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((v) => !v)}
        className={`grid min-h-16 w-full grid-cols-[minmax(0,1fr)_1.5rem] items-center gap-x-5 gap-y-0.5 px-4 py-3 text-left transition-colors duration-150 hover:bg-paper-sunken/60 focus-visible:outline-offset-[-3px] sm:grid-cols-[minmax(0,1fr)_auto_auto_1.5rem] sm:px-5 ${
          open ? "bg-paper-sunken/60" : ""
        }`}
      >
        <span className="col-start-1 row-start-1 min-w-0">
          <span className="block truncate text-[15.5px] font-semibold text-ink" title={team.name}>
            {team.name}
          </span>
          <span className="block truncate font-mono text-[12.5px] text-ink-faint">
            {team.repoFullName}
          </span>
        </span>
        {/* The column a TA sweeps. A team the platform has never run for is
            said in words, in ink, with the one attention mark on the row, so
            forty rows resolve to the handful worth opening without reading a
            single number. */}
        <span className="col-start-1 row-start-2 sm:col-start-2 sm:row-start-1 sm:max-w-[13.5rem] sm:text-right">
          {idle ? (
            <span className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-detect" />
              No hosted runs yet
            </span>
          ) : (
            <span className="u-tnum text-[13.5px] text-ink-secondary">
              {/* Totals span benchmark versions, so a single version's quota is not a denominator. */}
              {team.practiceUsed} practice run{team.practiceUsed === 1 ? "" : "s"} ·{" "}
              {team.officialUsed} official attempt{team.officialUsed === 1 ? "" : "s"}
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
          )}
        </span>
        <span className="col-start-1 row-start-3 truncate text-[13px] text-ink-faint sm:col-start-3 sm:row-start-1 sm:max-w-[8rem]">
          {team.tas.length > 0 ? `TA ${team.tas.map((ta) => ta.name ?? ta.login).join(", ")}` : "No TA"}
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: open ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.15, ease: EASE_OUT }}
          className="col-start-2 row-span-3 row-start-1 inline-flex justify-self-end self-center text-ink-faint sm:col-start-4 sm:row-span-1"
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={16} strokeWidth={1.8} />
        </motion.span>
      </button>

      <div id={detailsId}>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={reduce ? { opacity: 1, height: "auto" } : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={
                reduce
                  ? { opacity: 0, transition: { duration: 0 } }
                  : { height: 0, opacity: 0, transition: { duration: 0.16, ease: EASE_OUT } }
              }
              transition={{ duration: 0.22, ease: EASE_OUT }}
              className="overflow-hidden"
            >
              <div className="grid gap-x-8 gap-y-6 border-t border-rule-soft px-4 pt-4 pb-5 sm:grid-cols-2 sm:px-5">
                <div className="min-w-0">
                  <h3 className="u-label">Members</h3>
                  {team.members.length === 0 ? (
                    <p className="mt-1.5 text-[14px] text-ink-secondary">Nobody is on this team.</p>
                  ) : (
                    <ul className="mt-1 divide-y divide-rule-soft">
                      {team.members.map((m) => (
                        <li key={m.login} className="flex min-h-12 items-center gap-2 py-1">
                          <Person login={m.login} name={m.name} />
                          {/* The server refuses to remove an admin, so offering the
                              button would only lead to that refusal. Admin here is
                              GitHub's admin on the team's repository, the same word
                              the team page and the refusal use. */}
                          {m.role === "admin" ? (
                            <span className="shrink-0 px-2 text-[13px] font-semibold text-ink-secondary">
                              Admin
                            </span>
                          ) : (
                            <RemoveButton
                              armedLabel="Confirm, they leave"
                              name={`Remove ${m.login} from ${team.name}`}
                              armedName={`Confirm removing ${m.login} from ${team.name}`}
                              busy={removeMember.isPending && removeMember.variables?.login === m.login}
                              disabled={removeMember.isPending}
                              onConfirm={() =>
                                removeMember.mutate({ teamId: team.id, login: m.login }, { onSuccess: refocus })
                              }
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <LoginForm
                    id={`add-${team.id}`}
                    label="Add a student"
                    submit="Add"
                    busy={addMember.isPending}
                    suggestions={suggestions}
                    onSubmit={(login) =>
                      addMember
                        .mutateAsync({ teamId: team.id, login })
                        .then(() => true, () => false)
                    }
                  />
                  {memberError && (
                    <p role="alert" className="mt-2 text-[13.5px] text-detect-deep">
                      {memberError}
                    </p>
                  )}
                </div>

                <div className="min-w-0">
                  <h3 className="u-label">Teaching staff</h3>
                  {team.tas.length > 0 ? (
                    <ul className="mt-1 divide-y divide-rule-soft">
                      {team.tas.map((ta) => (
                        <li key={ta.login} className="flex min-h-12 items-center gap-2 py-1">
                          <Person login={ta.login} name={ta.name} avatarUrl={ta.avatarUrl} />
                          {canAssignTas ? (
                            <RemoveButton
                              label="Unassign"
                              busyLabel="Unassigning…"
                              armedLabel="Confirm unassign"
                              name={`Remove ${ta.login} as TA for ${team.name}`}
                              armedName={`Confirm removing ${ta.login} as TA for ${team.name}`}
                              busy={removeTa.isPending && removeTa.variables?.login === ta.login}
                              disabled={removeTa.isPending}
                              onConfirm={() =>
                                removeTa.mutate({ teamId: team.id, login: ta.login }, { onSuccess: refocus })
                              }
                            />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1.5 text-[14px] text-ink-secondary">No TA assigned.</p>
                  )}
                  {canAssignTas ? (
                    <LoginForm
                      id={`add-ta-${team.id}`}
                      label="Assign a TA"
                      submit="Assign"
                      busy={assignTa.isPending}
                      onSubmit={(login) =>
                        assignTa
                          .mutateAsync({ teamId: team.id, login })
                          .then(() => true, () => false)
                      }
                    />
                  ) : null}
                  {taError && (
                    <p role="alert" className="mt-2 text-[13.5px] text-detect-deep">
                      {taError}
                    </p>
                  )}
                </div>

                {/* The score is the leaderboard's business, not triage's: it
                    told a TA nothing about which team to open, and it took the
                    row's widest column to say it. Down here it is a footnote on
                    the team already being read. */}
                <p className="u-tnum border-t border-rule-soft pt-3 font-mono text-[12.5px] text-ink-faint sm:col-span-2">
                  {team.published
                    ? `Latest published score ${team.published.score.toFixed(3)} · ${team.published.benchmarkName ?? "benchmark not in the catalog"} v${team.published.benchmarkVersion}`
                    : "Nothing published yet"}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </li>
  );
}

/* ── Unassigned students: name, tenure, and a direct assignment ────────── */

/**
 * The section holds the result of an assignment rather than the row, because
 * a successful add takes the student out of this list: the row that made the
 * request is unmounted before it could report anything.
 */
function UnassignedSection({
  unassigned,
  teams,
}: {
  unassigned: { login: string; name: string | null; joinedAt: number | null }[];
  teams: AdminTeamSummary[];
}) {
  // seq remounts the line on every success, so a second assignment to the same
  // team is acknowledged rather than looking like the first one is still up.
  const [assigned, setAssigned] = useState<{ team: string; student: string; seq: number } | null>(
    null,
  );
  const options = teams.map((team) => ({ id: team.id, name: team.name }));

  return (
    <PageSection
      id="admin-unassigned"
      title="Students without a team"
      aside={<Count n={unassigned.length} />}
      note="Assigning here places the student on the team's roster. They still need collaborator access to the team's fork to push."
    >
      {unassigned.length === 0 ? (
        <p className="text-[15px] text-ink-secondary">Everyone in the cohort has a team.</p>
      ) : (
        <ul className="divide-y divide-rule-soft border-y border-rule-soft">
          {unassigned.map((student) => (
            <UnassignedRow
              key={student.login}
              student={student}
              teams={options}
              onAssigned={(team) =>
                setAssigned((prev) => ({
                  team,
                  student: student.name ?? student.login,
                  seq: (prev?.seq ?? 0) + 1,
                }))
              }
            />
          ))}
        </ul>
      )}
      {assigned ? (
        // The portal only claims what it can see, and the add response
        // (worker/routes/admin.ts) is the portal's own roster: it says
        // nothing about collaborator access on the fork, so this line does
        // not either.
        <p key={assigned.seq} role="status" className="anim-rise mt-3 text-[14px] text-ink">
          Added {assigned.student} to {assigned.team}.
        </p>
      ) : null}
    </PageSection>
  );
}

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
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <span className="flex min-w-[12rem] flex-1 items-center gap-3">
        <Person login={student.login} name={student.name} />
        {student.joinedAt != null && (
          <span className="hidden shrink-0 text-[13px] text-ink-faint sm:inline">
            joined {formatTimeAgo(student.joinedAt)}
          </span>
        )}
      </span>
      <span className="w-full sm:w-56">
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
          className="u-field cursor-pointer"
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
        {add.error && (
          <span role="alert" className="mt-1 block text-[13px] text-detect-deep">
            {add.error instanceof ApiRequestError
              ? add.error.message
              : "That assignment didn't go through. Pick the team again."}
          </span>
        )}
      </span>
    </li>
  );
}

/* ── Platform staff ────────────────────────────────────────────────────── */

/**
 * The roster that decides who has staff access to the portal, editable here
 * so a cohort change does not need a redeploy. Owners are shown but not
 * editable: they come from the deployment's configuration on purpose, which
 * is what guarantees this list can never lock every administrator out.
 *
 * Deliberately a plain list. An entry is an access grant, not a record of a
 * person, so there is nothing here to rank or score.
 */
function StaffSection() {
  const roster = useAdminStaffRoster();
  const add = useAdminAddStaff();
  const remove = useAdminRemoveStaff();
  const error = errorText([add.error, remove.error], "The roster did not change. Try again.");

  return (
    <PageSection
      id="admin-staff"
      title="Platform staff"
      aside={roster.data ? <Count n={roster.data.entries.length + roster.data.owners.length} /> : null}
      note="Staff open this console and see the teams assigned to them. Owners come from the deployment's configuration, so this list can't remove them."
    >
      {roster.isPending ? (
        <LoadingMark label="Loading roster" />
      ) : roster.isError ? (
        <QueryError error={roster.error} retry={() => void roster.refetch()} />
      ) : (
        <>
          <ul className="divide-y divide-rule-soft border-y border-rule-soft">
            {roster.data.owners.map((login) => (
              <li key={`owner:${login}`} className="flex min-h-12 items-center gap-3 py-1.5">
                <Person login={login} name={null} />
                <span
                  className="shrink-0 px-2 text-[13px] font-semibold text-ink-secondary"
                  title="Set in the deployment's configuration, so this list cannot remove it."
                >
                  Owner
                </span>
              </li>
            ))}
            {roster.data.entries.map((entry) => (
              <li key={entry.login} className="flex min-h-12 flex-wrap items-center gap-x-3 py-1.5">
                <span className="flex min-w-0 flex-1 items-center gap-2.5">
                  <MemberAvatar login={entry.login} avatarUrl={null} size={24} />
                  <span className="min-w-0">
                    <span className="block truncate text-[14.5px] font-semibold text-ink">
                      {entry.name ?? entry.login}
                    </span>
                    <span className="block truncate text-[12.5px] text-ink-faint">
                      {entry.name ? (
                        <span className="font-mono">{entry.login}</span>
                      ) : (
                        // An entry is a login string, so a typo looks exactly
                        // like somebody who has not signed in yet. Saying which
                        // beats leaving an entry that quietly grants nothing.
                        <span title="Nobody with this login has signed in. If the spelling is wrong, this grants nothing.">
                          not signed in yet
                        </span>
                      )}
                      <span className="hidden sm:inline">
                        {" · "}added by {entry.grantedBy} {formatTimeAgo(entry.grantedAt)}
                      </span>
                    </span>
                  </span>
                </span>
                <RemoveButton
                  armedLabel="Confirm, access ends"
                  name={`Remove ${entry.login} from platform staff`}
                  armedName={`Confirm removing ${entry.login} from platform staff`}
                  busy={remove.isPending && remove.variables === entry.login}
                  disabled={remove.isPending}
                  onConfirm={() => remove.mutate(entry.login)}
                />
              </li>
            ))}
          </ul>
          {roster.data.entries.length === 0 && (
            <p className="mt-3 text-[14px] text-ink-secondary">
              No staff added yet. Owners already have access; add a GitHub login below to give
              someone else the same view.
            </p>
          )}

          <LoginForm
            id="add-staff"
            label="Add staff"
            submit="Add staff"
            busy={add.isPending}
            onSubmit={(login) => add.mutateAsync(login).then(() => true, () => false)}
          />
          {error && (
            <p role="alert" className="mt-2 text-[13.5px] text-detect-deep">
              {error}
            </p>
          )}
        </>
      )}
    </PageSection>
  );
}
