import { ArrowDown01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { FAILURE_CATALOG } from "@cogworks/contracts/failures";
import type { AdminTeamSummary } from "@cogworks/contracts/schema";
import { isTerminal } from "@cogworks/contracts/schema";
import { CornerBrackets } from "@/components/Brackets";
import { Button } from "@/components/Button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { DroppedLinkNotice } from "@/components/DroppedLinkNotice";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { MemberAvatar } from "@/components/MemberAvatar";
import { PageHeader } from "@/components/Note";
import { PageSection } from "@/components/PageSection";
import { RemoveButton } from "@/components/RemoveButton";
import { ApiRequestError } from "@/lib/api";
import { useFocusFallback } from "@/lib/focus";
import { formatDate, formatTimeAgo, isoDate } from "@/lib/format";
import { EASE_OUT } from "@/lib/motion";
import { PHASE_LABELS } from "@/lib/run-meta";
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
      {/* Staff without a team land here from a device or Discord link the
          portal couldn't approve; this says so before the console does. */}
      <DroppedLinkNotice teamOptional className="mb-8 max-w-[34rem]" />
      <PageHeader eyebrow={isOwner ? "Instructor console" : "TA workspace"} title={cohort.name} />

      {isOwner && cohort.joinCode ? (
        <Enrollment cohort={{ ...cohort, joinCode: cohort.joinCode }} />
      ) : null}

      <PageSection id="admin-teams" title="Teams" aside={<Count n={teams.length} />}>
        <div className="lg:max-w-[42rem]">
          {teams.length === 0 ? (
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
        </div>
      </PageSection>

      {isOwner ? <UnassignedSection unassigned={unassigned} teams={teams} /> : null}

      {isOwner ? <StaffSection /> : null}
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="u-tnum font-mono text-[13px] text-ink-faint">{n}</span>;
}

/**
 * The rows a TA has to act on sort first: a team the platform has never run
 * for, then a team that has run but never end to end, which is the team the
 * design doc's Wednesday nudge is for (docs/design/the-instrument-not-the-judge.md).
 * "Never run" is read from every hosted execution, not from the charged
 * counts: a failure never adds to those, so a team whose runs all failed used
 * to sort and read as one that had never started. Within a group the order is
 * by name.
 */
function triageOrder(teams: AdminTeamSummary[]): AdminTeamSummary[] {
  const group = (team: AdminTeamSummary) =>
    team.hostedRuns === 0 ? 0 : team.firstLight === null ? 1 : 2;
  return [...teams].sort(
    (left, right) => group(left) - group(right) || left.name.localeCompare(right.name),
  );
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
  // Whether focus was in the fold when a pointer pressed the toggle: WebKit
  // moves focus off an action to the body at mousedown, before click.
  const focusWasInFold = useRef(false);
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
        </div>
      </div>

      <div className="border-t border-rule-soft px-3 sm:px-4">
        <button
          type="button"
          aria-expanded={changing}
          aria-controls={foldId}
          onPointerDown={() => {
            focusWasInFold.current = Boolean(foldRef.current?.contains(document.activeElement));
          }}
          onClick={(event) => {
            // Safari doesn't focus a clicked button, so focus can be on an
            // action inside the fold (assistive-technology activation) or,
            // after a mouse press, already on the body; going inert would
            // leave it there.
            const wasInFold = focusWasInFold.current;
            focusWasInFold.current = false;
            if (changing && (wasInFold || foldRef.current?.contains(document.activeElement))) {
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
        {/* The wrapper stays mounted and goes inert the moment the fold
            closes, so nothing inside can take focus or be read out even for
            the frame before the actions unmount. Only the toggle closes the
            fold, and it takes focus back first. */}
        <div ref={foldRef} id={foldId} inert={!changing} aria-hidden={!changing}>
          {changing && (
            <div className="anim-reveal">
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
                      ? "New students can't join. Everyone already in keeps their place."
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
                    For a code that reached people outside the course.
                  </EnrollmentAction>
                  {patch.error && (
                    <p role="alert" className="text-[14px] text-detect-deep">
                      {patch.error instanceof ApiRequestError
                        ? patch.error.message
                        : "Enrollment didn't change. Try again in a moment."}
                    </p>
                  )}
                </div>
            </div>
          )}
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
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = `${id}-suggestions`;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim() || busy) return;
        const form = e.currentTarget;
        void onSubmit(value.trim()).then((added) => {
          if (!added) return;
          setValue("");
          // The cleared field disables the focused submit button, and a
          // disabled button drops focus to the page. The field is where the
          // next login goes.
          if (form.contains(document.activeElement)) inputRef.current?.focus();
        });
      }}
      className="mt-3"
    >
      <label htmlFor={id} className="u-label">
        {label}
      </label>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          ref={inputRef}
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
  const idle = team.hostedRuns === 0;
  const counted = team.practiceUsed + team.officialUsed;
  const detailsId = `team-${team.id}`;
  // A removed row takes its focused control with it; the row's own toggle is
  // the nearest stable place to put focus back.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const refocus = () => toggleRef.current?.focus();
  const detailsRef = useRef<HTMLDivElement>(null);
  // Whether focus was inside the details when a pointer pressed the toggle.
  // WebKit moves focus off a field to the body at mousedown, before click,
  // so by click time the details no longer hold it.
  const focusWasInside = useRef(false);

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
        onPointerDown={() => {
          focusWasInside.current = Boolean(detailsRef.current?.contains(document.activeElement));
        }}
        onClick={(event) => {
          // Safari doesn't focus a clicked button, so focus can be on a field
          // inside the details (assistive-technology activation) or, after a
          // mouse press, already on the body; either way unmounting the
          // details would leave it there.
          const wasInside = focusWasInside.current;
          focusWasInside.current = false;
          if (open && (wasInside || detailsRef.current?.contains(document.activeElement))) {
            event.currentTarget.focus();
          }
          setOpen((v) => !v);
        }}
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
        {/* The column a TA sweeps. A team the platform has never run for, or
            has never run end to end, is said in words, in ink, with the one
            attention mark on the row, so forty rows resolve to the handful
            worth opening without reading a single number. */}
        <span className="col-start-1 row-start-2 sm:col-start-2 sm:row-start-1 sm:max-w-[13.5rem] sm:text-right">
          {idle ? (
            <AttentionLine>No hosted runs yet</AttentionLine>
          ) : (
            <>
              {team.firstLight === null ? (
                <span className="block">
                  <AttentionLine>Not end to end yet</AttentionLine>
                </span>
              ) : null}
              <span className="u-tnum block text-[13.5px] text-ink-secondary">
                {/* What ran, then what counted against quota: a failed run is
                    activity a TA may need to open and never counts. Totals span
                    benchmark versions, so a single version's quota is not a
                    denominator. */}
                {team.hostedRuns} hosted run{team.hostedRuns === 1 ? "" : "s"} ·{" "}
                {counted === 0
                  ? "none counted"
                  : // Non-breaking, so a narrow row never leaves "counted" alone on a line.
                    `${team.practiceUsed} practice and ${team.officialUsed}\u00a0official\u00a0counted`}
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
            </>
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

      <div id={detailsId} ref={detailsRef}>
        {open && (
          <div className="anim-reveal">
              <div className="grid gap-x-8 gap-y-6 border-t border-rule-soft px-4 pt-4 pb-5 sm:grid-cols-2 sm:px-5">
                <TeamRunState team={team} />

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
                              subject={`${m.login} from ${team.name}`}
                              armedSubject={m.login}
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
                              subject={`${ta.login} as TA for ${team.name}`}
                              armedSubject={ta.login}
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
          </div>
        )}
      </div>
    </li>
  );
}

/** A row's one attention mark: detector red, beside a state said in ink. */
function AttentionLine({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-detect" />
      {children}
    </span>
  );
}

/**
 * Whether the team's code has run end to end, and where its last hosted run
 * stopped, for staff who can't open the team's run pages. Everything here is a
 * platform enum or a time: the phase label and the failure title and code are
 * the platform's own words (PHASE_LABELS, FAILURE_CATALOG), never the team's
 * failure detail or log.
 */
export function TeamRunState({
  team,
}: {
  team: Pick<AdminTeamSummary, "firstLight" | "lastHostedRun">;
}) {
  const { firstLight, lastHostedRun: last } = team;
  return (
    <div className="min-w-0 sm:col-span-2">
      <h3 className="u-label">Run state</h3>
      <p className="mt-1.5 max-w-[62ch] text-[14px] text-pretty text-ink">
        {firstLight ? (
          <>
            {/* The day, not the minute: the time of day says when someone
                on the team was working, which helping them doesn't need. */}
            {/* "From this repository": both sentences count only the
                repository this row names (worker/routes/admin.ts). */}
            First ran end to end from this repository on {firstLight.benchmarkTitle},{" "}
            <time dateTime={isoDate(firstLight.at)} className="whitespace-nowrap">
              {formatDate(firstLight.at)}
            </time>
            .
          </>
        ) : (
          "Hasn't run end to end from this repository yet."
        )}
      </p>
      {last ? (
        <p className="mt-1 max-w-[62ch] text-[14px] text-pretty text-ink">
          {/* Relative and coarse (minutes, hours, days), with no exact time
              on hover, for the reason first light shows only the day. */}
          Last hosted run: {last.benchmarkTitle},{" "}
          <time dateTime={isoDate(last.at)} className="whitespace-nowrap">
            {formatTimeAgo(last.at)}
          </time>
          , <LastRunOutcome run={last} />
        </p>
      ) : null}
    </div>
  );
}

/**
 * The end of the last-run sentence. A failure names its phase, then gives the
 * catalog title as a sentence of its own: joined to "stopped at", a title such
 * as "The evaluation stopped on an exception" repeated the verb.
 */
function LastRunOutcome({ run }: { run: NonNullable<AdminTeamSummary["lastHostedRun"]> }) {
  // Any status before a terminal one, queued included: the statuses the
  // database treats as an active run (the one-active-run index, migration
  // 0015). Said as what the overview saw when it loaded, not "going now": the
  // page doesn't poll, and only Modal runs are swept when they go silent
  // (worker/execution/maintenance.ts); a fixture run advances only when its
  // team's own pages sync it.
  if (!isTerminal(run.status)) return "no result yet.";
  // First light counts only a success with a finish time, as the Team page
  // does. One without would otherwise follow "Hasn't run end to end from
  // this repository yet." with "scored."; say what is recorded instead.
  if (run.status === "succeeded") {
    return run.finishRecorded ? "scored." : "succeeded with no finish time recorded.";
  }
  if (run.status === "cancelled") return "cancelled.";
  // A failed run that recorded no phase or category has nothing more the
  // platform can say about where it stopped.
  if (!run.failure) return "failed.";
  const failure = FAILURE_CATALOG[run.failure.category];
  return (
    <>
      failed at {PHASE_LABELS[run.failure.phase]}. {failure.title} (
      <span className="font-mono text-[13px] whitespace-nowrap">{failure.code}</span>).
    </>
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
  // An assigned student's row leaves the list with its focused control.
  // Focus goes to the team choice in the row that moved up into its place (or
  // the new last row), and after the last student to the line saying who was
  // added.
  const listRef = useRef<HTMLDivElement>(null);
  const addedRef = useRef<HTMLParagraphElement>(null);
  const focusedRow = useRef(0);
  const rows = () => [...(listRef.current?.querySelectorAll<HTMLLIElement>("li[data-unassigned]") ?? [])];
  const keepFocus = useFocusFallback(() => {
    const remaining = rows();
    const row = remaining[Math.min(focusedRow.current, remaining.length - 1)];
    return row?.querySelector("select") ?? addedRef.current;
  });

  return (
    <PageSection
      id="admin-unassigned"
      title="Students without a team"
      aside={<Count n={unassigned.length} />}
    >
      <div
        ref={listRef}
        className="lg:max-w-[42rem]"
        onFocus={(event) => {
          const row = rows().findIndex((item) => item.contains(document.activeElement));
          if (row >= 0) focusedRow.current = row;
          keepFocus.onFocus(event);
        }}
        onBlur={keepFocus.onBlur}
      >
        {unassigned.length === 0 ? (
          <p className="text-[15px] text-ink-secondary">Everyone in the cohort has a team.</p>
        ) : (
          <>
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
            {/* Assigning only touches the portal's roster; push access is
                GitHub's to grant, and the portal can't see whether it was. */}
            <p className="mt-2 text-[13.5px] text-ink-faint">
              To push, they also need collaborator access on the team's fork.
            </p>
          </>
        )}
        {assigned ? (
          // The add response is the portal's roster only; it says nothing
          // about collaborator access on the fork, so neither does this line.
          <p key={assigned.seq} ref={addedRef} tabIndex={-1} role="status" className="anim-rise mt-3 text-[14px] text-ink">
            Added {assigned.student} to {assigned.team}.
          </p>
        ) : null}
      </div>
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
  // Choosing a team only fills the field; Add commits. A select changes its
  // value on a typed letter in every browser, and on the arrow keys in some,
  // so assigning on change put a student on a team while a TA was still
  // looking for the right one. There is no form either: Chromium submits a
  // form on Enter in its select, which assigned the team a type-ahead had
  // just landed on.
  const [teamId, setTeamId] = useState("");
  const chosen = teams.find((option) => option.id === teamId);
  const selectRef = useRef<HTMLSelectElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  // A refetch can drop the chosen team. The field then shows "Choose a team…"
  // again rather than whichever option happens to be first, and focus leaves
  // Add before it becomes disabled.
  useEffect(() => {
    if (!teamId || chosen) return;
    const active = document.activeElement;
    if (active !== selectRef.current && controlsRef.current?.contains(active)) selectRef.current?.focus();
    setTeamId("");
  }, [teamId, chosen]);

  return (
    <li data-unassigned className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <span className="flex min-w-[12rem] flex-1 items-center gap-3">
        <Person login={student.login} name={student.name} />
        {student.joinedAt != null && (
          <span className="hidden shrink-0 text-[13px] text-ink-faint sm:inline">
            joined {formatTimeAgo(student.joinedAt)}
          </span>
        )}
      </span>
      <div ref={controlsRef} className="w-full sm:w-auto">
        <span className="flex items-center gap-2">
          {/* aria-disabled while assigning, because a disabled select drops
              focus before the row it belongs to leaves the list. */}
          <select
            ref={selectRef}
            aria-label={`Assign ${student.login} to a team`}
            value={chosen ? teamId : ""}
            disabled={teams.length === 0}
            aria-disabled={add.isPending || undefined}
            onChange={(e) => {
              if (!add.isPending) setTeamId(e.target.value);
            }}
            className="u-field min-w-0 flex-1 cursor-pointer sm:w-48 sm:flex-none"
          >
            <option value="" disabled>
              Choose a team…
            </option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="ghost"
            busy={add.isPending}
            disabled={!chosen}
            onClick={() => {
              if (!chosen || add.isPending) return;
              add.mutate(
                { teamId: chosen.id, login: student.login },
                { onSuccess: () => onAssigned(chosen.name) },
              );
            }}
            aria-label={chosen ? `Add ${student.login} to ${chosen.name}` : undefined}
          >
            Add
          </Button>
        </span>
        {add.error && (
          <span role="alert" className="mt-1 block text-[13px] text-detect-deep">
            {add.error instanceof ApiRequestError
              ? add.error.message
              : "That assignment didn't go through. Try Add again."}
          </span>
        )}
      </div>
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
    >
      <div className="lg:max-w-[42rem]">
        {roster.isPending ? (
          <LoadingMark label="Loading roster" />
        ) : roster.isError ? (
          <QueryError error={roster.error} retry={() => void roster.refetch()} />
        ) : (
          <>
            <ul className="divide-y divide-rule-soft border-y border-rule-soft">
              {roster.data.owners.map((login) => (
                <li key={`owner:${login}`} className="flex min-h-12 items-center gap-3 py-1.5">
                  <span className="flex min-w-0 flex-1 items-center gap-2.5">
                    <MemberAvatar login={login} avatarUrl={null} size={24} />
                    <span className="min-w-0">
                      <span className="block truncate text-[14.5px] font-semibold text-ink">{login}</span>
                      {/* Said on the row, since it is the reason the row has no Remove. */}
                      <span className="block text-[12.5px] leading-snug text-ink-faint">
                        set in deployment config, can't be removed here
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 px-2 text-[13px] font-semibold text-ink-secondary">
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
                    subject={`${entry.login} from platform staff`}
                    armedSubject={entry.login}
                    busy={remove.isPending && remove.variables === entry.login}
                    disabled={remove.isPending}
                    onConfirm={() => remove.mutate(entry.login)}
                  />
                </li>
              ))}
            </ul>
            {/* Said beside the form at every roster size: adding a login
                grants nothing until that person is assigned teams. */}
            <p className="mt-3 text-[14px] text-ink-secondary">
              {roster.data.entries.length === 0 && "No staff added yet. "}Staff see only the teams
              assigned to them.
            </p>

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
      </div>
    </PageSection>
  );
}
