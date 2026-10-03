import { ArrowUpRight01Icon, PencilEdit02Icon, UserAdd01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useRef, useState } from "react";
import type { GithubRepo, TeamDetail } from "@cogworks/contracts/schema";
import { Button } from "@/components/Button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { GitHubIcon } from "@/components/GitHubIcon";
import { GrantAccess } from "@/components/GrantAccess";
import { MemberAvatar } from "@/components/MemberAvatar";
import { MemberPalette } from "@/components/MemberPalette";
import { PageSection } from "@/components/PageSection";
import { ProcessPanel } from "@/components/ProcessPanel";
import { RemoveButton } from "@/components/RemoveButton";
import { RepoPicker } from "@/components/RepoPicker";
import { ApiRequestError } from "@/lib/api";
import {
  LeftButNotRefreshed,
  useChangeTeamRepo,
  useLeaveTeam,
  useRemoveTeamMember,
  useRepositories,
  useTeam,
  useUpdateTeam,
} from "@/lib/queries";

/**
 * Portal roles mirror the team's GitHub repository permissions: whoever GitHub
 * calls an admin on the fork is a team admin here, with the settings and
 * repository controls that implies. This is deliberate, so the label says
 * "Admin" rather than "Creator": there can be more than one, and the way to
 * grant or revoke it is on GitHub. Ordinary members carry no label, since a
 * word repeated on every row tells the reader nothing.
 */
const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  maintain: "Maintainer",
};

/**
 * Where a team looks at itself: who is on it, the repository it runs from,
 * and, last, what its commits and runs say about how the work went.
 *
 * People come first because they are what a student opens this page to check
 * (did my teammate get added, who is our TA). Everything a team admin can
 * change is edited in place, where it is read, rather than on a separate
 * settings form.
 */
export function TeamPage() {
  const team = useTeam();

  if (team.isPending) return <LoadingMark label="Loading team" />;
  if (team.isError) {
    return (
      <div className="page">
        <QueryError error={team.error} retry={() => void team.refetch()} />
      </div>
    );
  }

  const t = team.data;

  return (
    <div className="page anim-rise">
      <TeamHeading team={t} />
      <PeopleSection team={t} />
      <RepositorySection team={t} />
      {/* Last on the page, and the only section that is a reading rather
          than a setting: everything above it is something you change. */}
      <ProcessPanel members={t.members} />
    </div>
  );
}

/* ── Name and description ──────────────────────────────────────────────── */

const titleClass = "text-[clamp(2rem,1.5rem+2vw,2.75rem)] text-ink wrap-anywhere";

/** A quiet pencil control that sits on the line it edits. */
function EditControl({
  label,
  onClick,
  buttonRef,
  describedBy,
}: {
  label: string;
  onClick: () => void;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  describedBy?: string;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-describedby={describedBy}
      className="u-pressable inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control px-2 text-[13.5px] font-semibold text-ink-secondary transition-colors duration-150 hover:bg-ink/[0.045] hover:text-ink"
    >
      <HugeiconsIcon icon={PencilEdit02Icon} size={15} strokeWidth={1.8} aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * Focus goes back to the control that opened an editor once it closes, by
 * Save or by Cancel, so a keyboard user is never dropped at the top of the
 * document when the field unmounts.
 */
function useEditor() {
  const [editing, setEditing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const returning = useRef(false);

  useEffect(() => {
    if (!editing && returning.current) {
      returning.current = false;
      trigger.current?.focus();
    }
  }, [editing]);

  return {
    editing,
    trigger,
    open: () => setEditing(true),
    close: () => {
      returning.current = true;
      setEditing(false);
    },
  };
}

function TeamHeading({ team }: { team: TeamDetail }) {
  const name = useEditor();
  const description = useEditor();
  const nameUpdate = useUpdateTeam();
  const descriptionUpdate = useUpdateTeam();
  const [nameDraft, setNameDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const descriptionHint = useId();

  const saveName = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameDraft.trim() || nameUpdate.isPending) return;
    // Saving the name it already has is a no-op the server would still be asked about.
    if (nameDraft.trim() === team.name) return name.close();
    nameUpdate.mutate({ teamId: team.id, name: nameDraft.trim() }, { onSuccess: name.close });
  };

  const saveDescription = (e: React.FormEvent) => {
    e.preventDefault();
    if (descriptionUpdate.isPending) return;
    descriptionUpdate.mutate(
      { teamId: team.id, description: descriptionDraft.trim() || null },
      { onSuccess: description.close },
    );
  };

  const escapeCancels = (close: () => void, reset: () => void) => (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    reset();
    close();
  };

  return (
    <header className="max-w-[42rem]">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="u-eyebrow">Your team</span>
        {team.provenance === "archive" && (
          <span className="text-[13px] text-ink-faint">2026 cohort, anonymized</span>
        )}
      </div>

      {name.editing ? (
        <form
          onSubmit={saveName}
          onKeyDown={escapeCancels(name.close, nameUpdate.reset)}
          className="flex flex-wrap items-center gap-2"
        >
          <label htmlFor="rename" className="sr-only">
            Team name
          </label>
          <input
            id="rename"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            maxLength={60}
            autoFocus
            autoComplete="off"
            aria-invalid={nameUpdate.isError || undefined}
            className="h-14 min-w-0 flex-[1_1_18rem] rounded-control border border-rule-strong bg-paper-raised px-3 font-serif text-[28px] font-semibold tracking-[-0.018em] text-ink transition-colors duration-150 focus-visible:border-ink focus-visible:outline-offset-1 aria-invalid:border-detect"
          />
          <span className="flex items-center gap-2">
            <Button type="submit" busy={nameUpdate.isPending} disabled={!nameDraft.trim()}>
              Save name
            </Button>
            <Button
              type="button"
              variant="quiet"
              onClick={() => {
                nameUpdate.reset();
                name.close();
              }}
            >
              Cancel
            </Button>
          </span>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className={titleClass}>{team.name}</h1>
          {team.isAdmin && (
            <EditControl
              label="Rename"
              buttonRef={name.trigger}
              onClick={() => {
                setNameDraft(team.name);
                name.open();
              }}
            />
          )}
        </div>
      )}
      {nameUpdate.error && (
        <p role="alert" className="mt-2 text-[14px] text-detect-deep">
          {nameUpdate.error instanceof ApiRequestError
            ? nameUpdate.error.message
            : "The new name didn't save. Try again in a moment."}
        </p>
      )}

      {description.editing ? (
        <form
          onSubmit={saveDescription}
          onKeyDown={escapeCancels(description.close, descriptionUpdate.reset)}
          className="mt-4"
        >
          <label htmlFor="team-description" className="u-label">
            A line about your approach
          </label>
          <textarea
            id="team-description"
            value={descriptionDraft}
            onChange={(e) => setDescriptionDraft(e.target.value)}
            maxLength={280}
            rows={3}
            autoFocus
            aria-describedby={descriptionHint}
            aria-invalid={descriptionUpdate.isError || undefined}
            placeholder="We fingerprint peaks in pairs, so a short clip still lines up with the song."
            className="u-field mt-1.5 resize-y py-2.5 leading-[1.5]"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p id={descriptionHint} className="text-[13.5px] text-ink-secondary">
              Shown beside your published result on the leaderboard.{" "}
              <span className="u-tnum font-mono text-[12.5px] text-ink-faint">
                {descriptionDraft.length}/280
              </span>
            </p>
            <span className="flex items-center gap-2">
              <Button type="submit" busy={descriptionUpdate.isPending}>
                Save
              </Button>
              <Button
                type="button"
                variant="quiet"
                onClick={() => {
                  descriptionUpdate.reset();
                  description.close();
                }}
              >
                Cancel
              </Button>
            </span>
          </div>
        </form>
      ) : team.description ? (
        <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p className="max-w-[58ch] text-[16px] leading-[1.6] text-ink-secondary">
            {team.description}
          </p>
          {team.isAdmin && (
            <EditControl
              label="Edit"
              buttonRef={description.trigger}
              onClick={() => {
                setDescriptionDraft(team.description ?? "");
                description.open();
              }}
            />
          )}
        </div>
      ) : team.isAdmin ? (
        <div className="mt-2">
          <EditControl
            label="Add a line about your approach"
            buttonRef={description.trigger}
            onClick={() => {
              setDescriptionDraft("");
              description.open();
            }}
          />
        </div>
      ) : null}
      {descriptionUpdate.error && (
        <p role="alert" className="mt-2 text-[14px] text-detect-deep">
          {descriptionUpdate.error instanceof ApiRequestError
            ? descriptionUpdate.error.message
            : "The description didn't save. Your text is still in the box; try again."}
        </p>
      )}
    </header>
  );
}

/* ── People ────────────────────────────────────────────────────────────── */

/** Members, and for a team admin the door: add cohort students without a
 *  team, remove anyone but a team admin. Portal membership only; a GitHub
 *  collaborator invite is still what lets them push, and the palette says so
 *  when someone is added. */
function PeopleSection({ team }: { team: TeamDetail }) {
  const [adding, setAdding] = useState(false);
  // Remove unmounts the focused control; hand focus back to the add toggle
  // so keyboard users aren't dropped at the document root.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = () => toggleRef.current?.focus();
  const [leaveArmed, setLeaveArmed] = useState(false);

  return (
    <PageSection
      id="team-people"
      title="People"
      aside={
        team.isAdmin ? (
          <span className="relative">
            <button
              ref={toggleRef}
              type="button"
              aria-expanded={adding}
              aria-haspopup="dialog"
              onClick={() => setAdding((open) => !open)}
              className={`u-pressable inline-flex min-h-11 items-center gap-2 rounded-control border px-3.5 text-[14px] font-semibold transition-colors duration-150 ${
                adding
                  ? "border-ink bg-paper-raised text-ink"
                  : "border-rule-strong bg-paper-raised text-ink hover:border-ink"
              }`}
            >
              <HugeiconsIcon icon={UserAdd01Icon} size={16} strokeWidth={1.8} aria-hidden="true" />
              Add someone
            </button>
            <MemberPalette teamId={team.id} open={adding} onClose={() => setAdding(false)} triggerRef={toggleRef} />
          </span>
        ) : (
          // Where the missing Add button would be: who can change the list,
          // and that the role comes from GitHub rather than this page.
          <span className="text-[13px] text-ink-faint">GitHub repository admins manage people</span>
        )
      }
    >
      <div className="lg:max-w-[42rem]">
        <ul className="divide-y divide-rule-soft">
          {team.members.map((m, i) => {
            // The server marks the reader's row by user id; two rows can show
            // the same login, and only one of them is yours to leave.
            const isMe = m.isYou;
            return (
              // The login is the display name, and two development accounts can
              // share one (demo@dev.local beside a GitHub "demo"); GitHub logins
              // are unique, so the index only ever breaks a tie the server made.
              <li key={`${m.login}:${i}`} className="flex min-h-16 flex-wrap items-center gap-x-3.5 gap-y-1 py-2.5">
                <MemberAvatar login={m.login} avatarUrl={m.avatarUrl} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-[15.5px] font-semibold text-ink">
                      {m.name ?? m.login}
                    </span>
                    {isMe && <span className="shrink-0 text-[13px] text-ink-faint">you</span>}
                  </span>
                  {m.name && m.name !== m.login && (
                    <span className="block truncate font-mono text-[12.5px] text-ink-faint">
                      {m.login}
                    </span>
                  )}
                </span>
                {ROLE_LABELS[m.role] && (
                  <span className="shrink-0 text-[13px] font-semibold text-ink-secondary">
                    {ROLE_LABELS[m.role]}
                  </span>
                )}
                {isMe ? (
                  <LeaveTeam team={team} onArmedChange={setLeaveArmed} />
                ) : (
                  team.isAdmin && m.role !== "admin" && (
                    <RemoveMember teamId={team.id} login={m.login} onRemoved={restoreFocus} />
                  )
                )}
                {isMe && leaveArmed && (
                  <LeaveConsequence lastMember={team.members.length === 1} />
                )}
              </li>
            );
          })}
        </ul>

        <h3 className="mt-6 u-label">Teaching staff</h3>
        {team.tas.length > 0 ? (
          <ul className="mt-1 divide-y divide-rule-soft">
            {team.tas.map((ta) => (
              <li key={ta.login} className="flex min-h-14 items-center gap-3.5 py-2">
                <MemberAvatar login={ta.login} avatarUrl={ta.avatarUrl} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-ink">
                    {ta.name ?? ta.login}
                  </span>
                  {ta.name && (
                    <span className="block truncate font-mono text-[12.5px] text-ink-faint">
                      {ta.login}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[13px] font-semibold text-ink-secondary">TA</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-[14.5px] text-ink-secondary">No TA assigned yet.</p>
        )}
      </div>
    </PageSection>
  );
}

/**
 * Leaving, from the student's own row. It removes only their membership; the
 * label carries the act and the line under the row, shown only while armed,
 * carries what stays, because that is what someone hesitating here needs to
 * know and it does not fit in a label. Afterwards they land on the team
 * choice (useLeaveTeam), where this team is one Join away if GitHub still
 * gives them write access.
 */
function LeaveTeam({ team, onArmedChange }: { team: TeamDetail; onArmedChange: (armed: boolean) => void }) {
  const leave = useLeaveTeam();
  return (
    <span className="flex shrink-0 flex-col items-end">
      <RemoveButton
        label="Leave"
        armedLabel="Confirm, you leave"
        busyLabel="Leaving…"
        subject={`team ${team.name}`}
        armedSubject={team.name}
        busy={leave.isPending}
        onArmedChange={onArmedChange}
        onConfirm={() => leave.mutate({ teamId: team.id, teamName: team.name })}
      />
      {leave.error instanceof LeftButNotRefreshed ? (
        <span role="alert" className="flex max-w-[16rem] flex-col items-end gap-1 text-right text-[12.5px] text-detect-deep">
          {leave.error.message}
          <Button variant="ghost" onClick={() => window.location.reload()}>
            Reload page
          </Button>
        </span>
      ) : leave.error && (
        <span role="alert" className="max-w-[16rem] text-right text-[12.5px] text-detect-deep">
          {leave.error instanceof ApiRequestError
            ? leave.error.message
            : "We couldn't confirm whether you left. Leaving again is safe; if you'd already left, it will say so."}
        </span>
      )}
    </span>
  );
}

/** Each sentence is a server fact: the delete touches one team_members row
 *  (routes/team-membership.ts), and team report lists are built from the
 *  current roster (services/local-reports.ts). */
function LeaveConsequence({ lastMember }: { lastMember: boolean }) {
  return (
    <p role="status" className="basis-full max-w-[calc(60ch+36px+0.875rem)] pl-[calc(36px+0.875rem)] text-[13.5px] leading-[1.5] text-ink-secondary">
      {lastMember
        ? "You're the last member, so the team will be empty. It keeps its repository, runs and results, and anyone with write access on GitHub can join it again."
        : "Only you come off the team; its hosted runs, attempts and published results stay. Your local reports leave its list with you, and your GitHub access doesn't change."}
    </p>
  );
}

function RemoveMember({ teamId, login, onRemoved }: { teamId: string; login: string; onRemoved: () => void }) {
  const remove = useRemoveTeamMember();
  return (
    <span className="flex shrink-0 flex-col items-end">
      <RemoveButton
        armedLabel="Confirm, they leave"
        subject={`@${login} from the team`}
        armedSubject={`@${login}`}
        busy={remove.isPending}
        onConfirm={() => remove.mutate({ teamId, login }, { onSuccess: onRemoved })}
      />
      {remove.error && (
        <span role="alert" className="max-w-[16rem] text-right text-[12.5px] text-detect-deep">
          {remove.error instanceof ApiRequestError
            ? remove.error.message
            : `@${login} is still on the team. Try removing them again.`}
        </span>
      )}
    </span>
  );
}

/* ── Repository ────────────────────────────────────────────────────────── */

function RepositorySection({ team }: { team: TeamDetail }) {
  return (
    <PageSection id="team-repository" title="Repository">
      <div className="lg:max-w-[42rem]">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <a
            href={team.repo.url}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex min-h-11 min-w-0 items-center gap-2.5 text-ink"
          >
            <GitHubIcon className="size-[18px] shrink-0" />
            <span className="truncate font-mono text-[14.5px] underline decoration-rule-strong underline-offset-4 transition-colors duration-150 group-hover:decoration-ink">
              {team.repo.fullName}
            </span>
            <HugeiconsIcon
              icon={ArrowUpRight01Icon}
              size={14}
              strokeWidth={1.8}
              className="shrink-0 text-ink-faint"
              aria-hidden="true"
            />
            <span className="sr-only">(opens GitHub)</span>
          </a>
          <span className="font-mono text-[12.5px] text-ink-faint">
            default branch {team.repo.defaultBranch}
          </span>
        </div>
        {team.isAdmin && <ChangeRepository teamId={team.id} currentFullName={team.repo.fullName} />}
      </div>
    </PageSection>
  );
}

/** Admin-only: repoint the team at a different repository. History and
 *  attempts stay with the team; blocked server-side while a run is active. */
function ChangeRepository({ teamId, currentFullName }: { teamId: string; currentFullName: string }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<GithubRepo | null>(null);
  const repos = useRepositories(open);
  const change = useChangeTeamRepo();
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const returning = useRef(false);
  const labelId = useId();

  // The toggle unmounts as the panel opens, so without this focus falls to
  // the page. From the panel, the next Tab reaches the first repository.
  useEffect(() => {
    if (open) {
      panel.current?.focus();
    } else if (returning.current) {
      returning.current = false;
      toggle.current?.focus();
    }
  }, [open]);

  const close = () => {
    returning.current = true;
    setOpen(false);
    setSelected(null);
    change.reset();
  };

  if (!open) {
    return (
      <button
        ref={toggle}
        type="button"
        onClick={() => setOpen(true)}
        className="u-pressable mt-2 -ml-2 inline-flex min-h-11 items-center rounded-control px-2 text-[14px] font-semibold text-ink-secondary transition-colors duration-150 hover:bg-ink/[0.045] hover:text-ink"
      >
        Change repository
      </button>
    );
  }

  return (
    <div
      ref={panel}
      role="group"
      aria-labelledby={labelId}
      tabIndex={-1}
      className="anim-rise mt-4 rounded-surface border border-rule bg-paper-raised p-4 sm:p-5"
    >
      <p id={labelId} className="u-label mb-3">Pick the repository your next run starts from</p>
      {repos.isPending ? (
        <LoadingMark label="Listing repositories" />
      ) : repos.isError ? (
        <QueryError error={repos.error} retry={() => void repos.refetch()} />
      ) : (
        <>
          <RepoPicker
            repos={repos.data}
            selected={selected}
            onPick={setSelected}
            disableClaimed
            currentFullName={currentFullName}
            initialVisibleCount={6}
          />
          <GrantAccess hasRepos={repos.data.length > 0} />
        </>
      )}

      {change.error && (
        <p role="alert" className="mt-3 text-[14px] text-detect-deep">
          {change.error instanceof ApiRequestError
            ? change.error.message
            : "The repository didn't change. Pick it again and confirm."}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <ConfirmButton
          label={selected ? `Switch to ${selected.fullName}` : "Change repository"}
          confirmLabel="Confirm, history and attempts stay with the team"
          onConfirm={() => {
            if (!selected) return;
            change.mutate({ teamId, fullName: selected.fullName }, {
              onSuccess: () => {
                returning.current = true;
                setOpen(false);
                setSelected(null);
              },
            });
          }}
          busy={change.isPending}
          disabled={!selected}
          variant="primary"
        />
        <Button type="button" variant="quiet" onClick={close}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
