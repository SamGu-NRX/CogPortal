import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import type { GithubRepo } from "@cogworks/contracts/schema";
import { Button } from "@/components/Button";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { GrantAccess } from "@/components/GrantAccess";
import { RepoPicker } from "@/components/RepoPicker";
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
            <p className="text-[14px] text-ink">
              No repositories are visible to the app yet.
            </p>
            {session?.auth.templateRepo && (
              <p className="mt-1.5 text-[13px] text-ink-secondary">
                Fork the template first, then grant the app access to your fork.
              </p>
            )}
            <GrantAccess hasRepos={false} />
          </div>
        ) : (
          <>
            <RepoPicker
              repos={repos.data}
              selected={selected}
              onPick={pick}
              initialVisibleCount={6}
            />
            <GrantAccess hasRepos />
          </>
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
