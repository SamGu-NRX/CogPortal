import { ArrowRight01Icon, TeacherIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { GithubRepo, TeamDetail } from "@cogworks/contracts/schema";
import { Button } from "@/components/Button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { GrantAccess } from "@/components/GrantAccess";
import { MemberAvatar } from "@/components/MemberAvatar";
import { MemberPalette } from "@/components/MemberPalette";
import { Panel } from "@/components/Panel";
import { ProcessPanel } from "@/components/ProcessPanel";
import { RepoPicker } from "@/components/RepoPicker";
import { ApiRequestError } from "@/lib/api";
import {
  useChangeTeamRepo,
  useRemoveTeamMember,
  useRepositories,
  useTeam,
  useUpdateTeam,
} from "@/lib/queries";

/**
 * Portal roles mirror the team's GitHub repository permissions: whoever GitHub
 * calls an admin on the fork is a team admin here, with the settings and
 * repository controls that implies. This is deliberate, so the label says
 * "admin" rather than "creator": there can be more than one, and the way to
 * grant or revoke it is on GitHub.
 */
const ROLE_LABELS: Record<string, string> = {
  admin: "admin",
  maintain: "maintainer",
  write: "member",
};

/** Team settings: name, description, members, and the connected repository. */
export function TeamPage() {
  const team = useTeam();
  const update = useUpdateTeam();
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [description, setDescription] = useState("");

  if (team.isPending) return <LoadingMark label="Loading team" />;
  if (team.isError) {
    return (
      <div className="py-14">
        <QueryError error={team.error} retry={() => void team.refetch()} />
      </div>
    );
  }

  const t = team.data;

  const saveName = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || update.isPending) return;
    update.mutate({ name: name.trim() }, { onSuccess: () => setEditingName(false) });
  };

  const saveDescription = (e: React.FormEvent) => {
    e.preventDefault();
    if (update.isPending) return;
    update.mutate(
      { description: description.trim() || null },
      { onSuccess: () => setEditingDescription(false) },
    );
  };

  return (
    <div className="anim-rise mx-auto w-full max-w-lg py-14">
      <p className="u-kicker">Team settings</p>

      {/* ── Name ── */}
      {editingName ? (
        <form onSubmit={saveName} className="mt-2 flex items-center gap-2">
          <label htmlFor="rename" className="sr-only">
            Team name
          </label>
          <input
            id="rename"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            autoFocus
            className="h-11 min-w-0 flex-1 border border-rule bg-paper-sunken px-3 font-serif text-xl font-semibold text-ink"
          />
          <Button type="submit" busy={update.isPending} disabled={!name.trim()}>
            Save
          </Button>
          <Button type="button" variant="quiet" onClick={() => setEditingName(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="text-3xl">{t.name}</h1>
          {t.isAdmin && (
            <button
              type="button"
              onClick={() => {
                setName(t.name);
                setEditingName(true);
              }}
              className="u-pressable min-h-8 font-mono text-[11px] tracking-[0.09em] text-ink-secondary uppercase hover:text-ink"
            >
              Rename
            </button>
          )}
        </div>
      )}

      {/* ── Description ── */}
      {editingDescription ? (
        <form onSubmit={saveDescription} className="mt-3">
          <label htmlFor="team-description" className="sr-only">
            Team description
          </label>
          <textarea
            id="team-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={280}
            rows={3}
            autoFocus
            placeholder="One line about your approach, shown on the leaderboard."
            className="w-full border border-rule bg-paper-sunken px-3 py-2 text-[14px] text-ink placeholder:text-ink-faint"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button type="submit" busy={update.isPending}>
              Save
            </Button>
            <Button type="button" variant="quiet" onClick={() => setEditingDescription(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {t.description ? (
            <p className="text-[14px] text-ink-secondary">{t.description}</p>
          ) : t.isAdmin ? (
            <p className="text-[13px] text-ink-faint">No description yet.</p>
          ) : null}
          {t.isAdmin && (
            <button
              type="button"
              onClick={() => {
                setDescription(t.description ?? "");
                setEditingDescription(true);
              }}
              className="u-pressable min-h-8 font-mono text-[11px] tracking-[0.09em] text-ink-secondary uppercase hover:text-ink"
            >
              {t.description ? "Edit" : "Add description"}
            </button>
          )}
        </div>
      )}
      {update.error && (
        <p role="alert" className="mt-2 text-[13px] text-detect-deep">
          {update.error instanceof ApiRequestError
            ? update.error.message
            : "Update failed."}
        </p>
      )}

      {/* ── Assigned teaching staff ── */}
      <Panel label={t.tas.length === 1 ? "ASSIGNED TA" : "ASSIGNED TAS"} className="mt-8">
        {t.tas.length > 0 ? (
          <ul className="divide-y divide-rule-soft">
            {t.tas.map((ta) => (
              <li key={ta.login} className="flex items-center gap-3 py-2.5">
                {ta.avatarUrl ? (
                  <img src={ta.avatarUrl} alt="" className="size-7 rounded-[2px]" />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex size-7 items-center justify-center border border-rule bg-paper-sunken font-mono text-[10px] text-ink-secondary uppercase"
                  >
                    {ta.login[0]}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">
                    {ta.name ?? ta.login}
                  </span>
                  {ta.name ? (
                    <span className="block truncate font-mono text-[11px] text-ink-faint">
                      @{ta.login}
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.08em] text-verify-deep uppercase">
                  <HugeiconsIcon icon={TeacherIcon} size={14} strokeWidth={1.8} aria-hidden="true" />
                  TA
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-2 text-[13px] text-ink-faint">No TA has been assigned yet.</p>
        )}
      </Panel>

      {/* ── Members ── */}
      <MembersPanel team={t} />

      {/* ── Repository ── */}
      <Panel label="REPOSITORY" className="mt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <a
            href={t.repo.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[13px] text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
          >
            {t.repo.fullName}
          </a>
          <span className="font-mono text-[11px] text-ink-faint">
            default {t.repo.defaultBranch}
          </span>
        </div>
        {t.isAdmin && <ChangeRepository currentFullName={t.repo.fullName} />}
      </Panel>

      {/* ── Where the work went, read from this team's commits and runs ──
          Last on the page, and the only panel here that is a reading rather
          than a setting: everything above it is something you change. */}
      <ProcessPanel members={t.members} />

      <Link
        to="/dashboard"
        className="u-pressable mt-8 inline-flex h-11 items-center gap-2 bg-ink px-6 text-[13.5px] font-medium tracking-wide text-paper-raised transition-colors duration-150 hover:bg-ink/90"
      >
        Open dashboard
        <HugeiconsIcon icon={ArrowRight01Icon} size={15} strokeWidth={1.8} aria-hidden="true" />
      </Link>
    </div>
  );
}

/** Members, and for a team admin the door: add cohort students without a
 *  team, remove anyone but a team admin. Portal membership only; a GitHub
 *  collaborator invite is still what lets them push. */
function MembersPanel({ team }: { team: TeamDetail }) {
  const [adding, setAdding] = useState(false);
  // Remove unmounts the focused control — hand focus back to the panel
  // toggle so keyboard users aren't dropped at the document root.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = () => toggleRef.current?.focus();

  return (
    <Panel
      label="MEMBERS"
      className="mt-4"
      aside={
        team.isAdmin ? (
          <span className="relative">
            <button
              ref={toggleRef}
              type="button"
              aria-expanded={adding}
              aria-haspopup="dialog"
              onClick={() => setAdding((open) => !open)}
              className="u-pressable min-h-8 font-mono text-[11px] tracking-[0.09em] text-ink-secondary uppercase hover:text-ink"
            >
              {adding ? "Close" : "Add member"}
            </button>
            <MemberPalette
              open={adding}
              onClose={() => setAdding(false)}
              triggerRef={toggleRef}
            />
          </span>
        ) : undefined
      }
    >
      <ul className="divide-y divide-rule-soft">
        {team.members.map((m) => (
          <li key={m.login} className="flex items-center gap-3 py-2.5">
            <MemberAvatar login={m.login} avatarUrl={m.avatarUrl} />
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">
              {m.login}
              {m.name && <span className="ml-2 text-ink-faint">{m.name}</span>}
            </span>
            {team.isAdmin && m.role !== "admin" && (
              <RemoveMember login={m.login} onRemoved={restoreFocus} />
            )}
            <span
              className={`font-mono text-[10.5px] tracking-[0.08em] uppercase ${
                m.role === "admin" ? "text-detect-deep" : "text-ink-faint"
              }`}
            >
              {ROLE_LABELS[m.role] ?? m.role}
            </span>
          </li>
        ))}
      </ul>

    </Panel>
  );
}

/** Two-step inline remove — arm, then confirm; arming decays after 4s. */
function RemoveMember({ login, onRemoved }: { login: string; onRemoved: () => void }) {
  const remove = useRemoveTeamMember();
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const click = () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setArmed(false);
    remove.mutate(login, { onSuccess: onRemoved });
  };

  return (
    <span className="flex items-center gap-2">
      {remove.error && (
        <span role="alert" className="text-[11px] text-detect-deep">
          {remove.error instanceof ApiRequestError ? remove.error.message : "Failed."}
        </span>
      )}
      <button
        type="button"
        onClick={click}
        disabled={remove.isPending}
        aria-label={
          armed ? `Confirm removing @${login}` : `Remove @${login} from the team`
        }
        aria-live="polite"
        className={`u-pressable min-h-8 px-1.5 font-mono text-[10.5px] tracking-[0.08em] uppercase transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
          armed ? "text-detect-deep" : "text-ink-faint hover:text-ink"
        }`}
      >
        {remove.isPending ? "Removing…" : armed ? "Confirm remove?" : "Remove"}
      </button>
    </span>
  );
}

/** Admin-only: repoint the team at a different repository. History and
 *  attempts stay with the team; blocked server-side while a run is active. */
function ChangeRepository({ currentFullName }: { currentFullName: string }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<GithubRepo | null>(null);
  const repos = useRepositories(open);
  const change = useChangeTeamRepo();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="u-pressable mt-3 min-h-8 border-t border-rule-soft pt-3 font-mono text-[11px] tracking-[0.09em] text-ink-secondary uppercase hover:text-ink"
      >
        Change repository
      </button>
    );
  }

  return (
    <div className="anim-rise mt-4 border-t border-rule-soft pt-4">
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
        <p role="alert" className="mt-3 text-[13px] text-detect-deep">
          {change.error instanceof ApiRequestError
            ? change.error.message
            : "Changing the repository failed."}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <ConfirmButton
          label="Change repository"
          confirmLabel="Confirm, history stays with the team"
          onConfirm={() => {
            if (!selected) return;
            change.mutate(selected.fullName, {
              onSuccess: () => {
                setOpen(false);
                setSelected(null);
              },
            });
          }}
          busy={change.isPending}
          disabled={!selected}
          variant="primary"
        />
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            setOpen(false);
            setSelected(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
