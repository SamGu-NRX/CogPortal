import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import type { GithubRepo } from "@shared/schema";
import { Button } from "@/components/Button";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { ApiRequestError } from "@/lib/api";
import { useConnectRepo, useRepositories, useSession } from "@/lib/queries";

/**
 * One page, two outcomes: an unclaimed repo asks for a team name (the first
 * connector creates and owns the team); a claimed repo is joined directly.
 */
export function ConnectPage() {
  const { data: session } = useSession();
  const repos = useRepositories();
  const connect = useConnectRepo();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<GithubRepo | null>(null);
  const [teamName, setTeamName] = useState("");

  if (session?.team) return <Navigate to="/dashboard" replace />;

  const pick = (repo: GithubRepo) => {
    setSelected(repo);
    if (!repo.claimedByTeam) setTeamName(defaultTeamName(repo.name));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || connect.isPending) return;
    const creating = !selected.claimedByTeam;
    if (creating && !teamName.trim()) return;
    connect.mutate(
      { fullName: selected.fullName, teamName: creating ? teamName.trim() : undefined },
      { onSuccess: () => navigate(creating ? "/team" : "/dashboard", { replace: true }) },
    );
  };

  return (
    <div className="anim-rise mx-auto w-full max-w-lg py-14">
      <h1 className="text-3xl">Connect your fork</h1>
      <p className="mt-2 text-[14px] text-ink-secondary">
        The repository is the team — everyone with write access shares its
        attempts.
        {session?.auth.templateRepo && (
          <> Must be a public fork of <code className="text-[12.5px] text-ink">{session.auth.templateRepo}</code>.</>
        )}
      </p>

      <form onSubmit={submit} className="mt-8">
        {repos.isPending ? (
          <LoadingMark label="Listing repositories" />
        ) : repos.isError ? (
          <QueryError error={repos.error} retry={() => void repos.refetch()} />
        ) : repos.data.length === 0 ? (
          <div className="border border-rule bg-paper-raised px-5 py-5">
            <p className="text-[14px] text-ink">No repositories are visible yet.</p>
            {session?.auth.githubConfigured && session.auth.appSlug ? (
              <a
                href={`https://github.com/apps/${session.auth.appSlug}/installations/new`}
                target="_blank"
                rel="noreferrer"
                className="u-pressable mt-3 inline-flex min-h-10 items-center font-mono text-[11.5px] tracking-[0.09em] text-ink uppercase underline decoration-rule underline-offset-4 hover:decoration-ink"
              >
                Grant access on GitHub ↗
              </a>
            ) : (
              <p className="mt-2 text-[13px] text-ink-secondary">
                Fork the template, then return here.
              </p>
            )}
          </div>
        ) : (
          <fieldset>
            <legend className="sr-only">Repositories</legend>
            <div className="space-y-2">
              {repos.data.map((repo) => (
                <label
                  key={repo.fullName}
                  className={`flex cursor-pointer items-center gap-3 border bg-paper-raised px-4 py-3 transition-colors duration-150 ${
                    selected?.fullName === repo.fullName
                      ? "border-ink"
                      : "border-rule hover:border-ink-secondary"
                  }`}
                >
                  <input
                    type="radio"
                    name="repository"
                    checked={selected?.fullName === repo.fullName}
                    onChange={() => pick(repo)}
                    className="accent-[#c63d2f]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[13.5px] font-medium text-ink">
                      {repo.fullName}
                    </span>
                  </span>
                  {repo.claimedByTeam && (
                    <span className="shrink-0 font-mono text-[10.5px] tracking-[0.07em] text-ink-faint uppercase">
                      team · {repo.claimedByTeam}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {/* Second step appears only once a repo is chosen. */}
        {selected && !selected.claimedByTeam && (
          <div className="anim-rise mt-6">
            <label htmlFor="team-name" className="u-kicker block">
              Team name
            </label>
            <input
              id="team-name"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              maxLength={60}
              autoComplete="off"
              className="mt-2 h-11 w-full border border-rule bg-paper-sunken px-3 text-[15px] text-ink placeholder:text-ink-faint"
              placeholder="Team name"
            />
            <p className="mt-1.5 text-[12px] text-ink-faint">
              Shown on the public leaderboard. You can rename it later.
            </p>
          </div>
        )}

        {connect.error && (
          <p role="alert" className="mt-4 text-[13px] text-detect-deep">
            {connect.error instanceof ApiRequestError
              ? connect.error.message
              : "Connecting failed. Try again."}
          </p>
        )}

        <Button
          type="submit"
          className="mt-6 w-full"
          busy={connect.isPending}
          disabled={!selected || (!selected.claimedByTeam && !teamName.trim())}
        >
          {!selected
            ? "Select a repository"
            : selected.claimedByTeam
              ? `Join ${selected.claimedByTeam}`
              : "Create team"}
        </Button>
      </form>
    </div>
  );
}

function defaultTeamName(repoName: string): string {
  return repoName
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .slice(0, 60);
}
