import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/Button";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { Panel } from "@/components/Panel";
import { ApiRequestError } from "@/lib/api";
import { useRenameTeam, useTeam } from "@/lib/queries";

const ROLE_LABELS: Record<string, string> = {
  admin: "creator",
  maintain: "maintainer",
  write: "member",
};

export function TeamPage() {
  const team = useTeam();
  const rename = useRenameTeam();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");

  if (team.isPending) return <LoadingMark label="Loading team" />;
  if (team.isError) {
    return (
      <div className="py-14">
        <QueryError error={team.error} retry={() => void team.refetch()} />
      </div>
    );
  }

  const t = team.data;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || rename.isPending) return;
    rename.mutate(name.trim(), { onSuccess: () => setEditing(false) });
  };

  return (
    <div className="anim-rise mx-auto w-full max-w-lg py-14">
      <p className="u-kicker">Team</p>

      {editing ? (
        <form onSubmit={save} className="mt-2 flex items-center gap-2">
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
          <Button type="submit" busy={rename.isPending} disabled={!name.trim()}>
            Save
          </Button>
          <Button type="button" variant="quiet" onClick={() => setEditing(false)}>
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
                setEditing(true);
              }}
              className="u-pressable min-h-8 font-mono text-[11px] tracking-[0.09em] text-ink-secondary uppercase hover:text-ink"
            >
              Rename
            </button>
          )}
        </div>
      )}
      {rename.error && (
        <p role="alert" className="mt-2 text-[13px] text-detect-deep">
          {rename.error instanceof ApiRequestError
            ? rename.error.message
            : "Rename failed."}
        </p>
      )}
      {t.description && (
        <p className="mt-2 text-[14px] text-ink-secondary">{t.description}</p>
      )}

      <Panel label="MEMBERS" className="mt-8">
        <ul className="divide-y divide-rule-soft">
          {t.members.map((m) => (
            <li key={m.login} className="flex items-center gap-3 py-2.5">
              {m.avatarUrl ? (
                <img src={m.avatarUrl} alt="" className="size-6 rounded-[2px]" />
              ) : (
                <span aria-hidden="true" className="size-6 border border-rule bg-paper-sunken" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">
                {m.login}
                {m.name && <span className="ml-2 text-ink-faint">{m.name}</span>}
              </span>
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
      </Panel>

      <Link
        to="/dashboard"
        className="u-pressable mt-8 inline-flex h-11 items-center bg-ink px-6 text-[13.5px] font-medium tracking-wide text-paper-raised transition-colors duration-150 hover:bg-ink/90"
      >
        Open dashboard →
      </Link>
    </div>
  );
}
