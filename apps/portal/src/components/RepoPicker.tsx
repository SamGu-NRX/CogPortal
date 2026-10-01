import { GitForkIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { GithubRepo } from "@cogworks/contracts/schema";
import { Veil } from "@/components/Veil";
import { formatTimeAgo } from "@/lib/format";

/**
 * Enriched repository radio-card list, shared by Connect and Team settings.
 * Shows what GitHub actually knows: description, fork status, last push.
 */
export function RepoPicker({
  repos,
  selected,
  onPick,
  disableClaimed = false,
  currentFullName = null,
  initialVisibleCount,
}: {
  repos: GithubRepo[];
  selected: GithubRepo | null;
  onPick: (repo: GithubRepo) => void;
  /** Team settings: repos claimed by another team are unpickable. */
  disableClaimed?: boolean;
  /** Team settings: mark the team's own repo. */
  currentFullName?: string | null;
  /** Progressively disclose long lists. Omit to show every repository. */
  initialVisibleCount?: number;
}) {
  const sortedRepos = [...repos].sort(compareReposByRecency);
  const visibleCount = Math.max(1, initialVisibleCount ?? sortedRepos.length);
  const recentRepos = sortedRepos.slice(0, visibleCount);
  const olderRepos = sortedRepos.slice(visibleCount);

  return (
    <fieldset>
      <legend className="sr-only">Repositories</legend>
      <div className="space-y-2">
        {recentRepos.map((repo) => (
          <RepositoryOption
            key={repo.fullName}
            repo={repo}
            selected={selected}
            onPick={onPick}
            disableClaimed={disableClaimed}
            currentFullName={currentFullName}
          />
        ))}
      </div>

      {olderRepos.length > 0 && (
        <Veil
          count={olderRepos.length}
          moreLabel={`See ${olderRepos.length} more ${olderRepos.length === 1 ? "repository" : "repositories"}`}
          fewerLabel="Show recent only"
          detail="Older repositories · newest first"
          focusSelector='input[type="radio"]'
        >
          {olderRepos.map((repo) => (
            <RepositoryOption
              key={repo.fullName}
              repo={repo}
              selected={selected}
              onPick={onPick}
              disableClaimed={disableClaimed}
              currentFullName={currentFullName}
            />
          ))}
        </Veil>
      )}
    </fieldset>
  );
}

function RepositoryOption({
  repo,
  selected,
  onPick,
  disableClaimed,
  currentFullName,
}: {
  repo: GithubRepo;
  selected: GithubRepo | null;
  onPick: (repo: GithubRepo) => void;
  disableClaimed: boolean;
  currentFullName: string | null;
}) {
  const isCurrent = repo.fullName === currentFullName;
  const claimedByOther = repo.claimedByTeam !== null && !isCurrent;
  const disabled = disableClaimed && (claimedByOther || isCurrent);
  const picked = selected?.fullName === repo.fullName;

  return (
    <label
      className={`relative flex items-start gap-3 rounded-surface border px-4 py-3.5 transition-[border-color,background-color] duration-150 ${
        disabled
          ? "cursor-not-allowed border-rule bg-paper-raised opacity-55"
          : picked
            ? "cursor-pointer border-ink bg-paper-raised shadow-[inset_0_0_0_1px_var(--color-ink)]"
            : "cursor-pointer border-rule bg-paper-raised hover:border-ink-secondary"
      }`}
    >
      {/* Selection is ink. Detector red means consequence on this site, and
          picking a repository has none until the button below is pressed. */}
      <input
        type="radio"
        name="repository"
        checked={picked}
        disabled={disabled}
        onChange={() => onPick(repo)}
        className="mt-[3px] size-4 shrink-0 accent-ink"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate font-mono text-[14px] font-medium text-ink">
            {repo.fullName}
          </span>
          <span className="flex shrink-0 items-center gap-2.5 text-[12.5px] text-ink-faint">
            {repo.isFork && (
              <span className="flex items-center gap-1">
                <HugeiconsIcon icon={GitForkIcon} size={12} strokeWidth={1.8} aria-hidden="true" />
                Fork
              </span>
            )}
            {isCurrent && <span className="font-semibold text-verify-deep">Current</span>}
          </span>
        </span>
        {repo.description && (
          <span
            title={repo.description}
            className="mt-1 line-clamp-1 block text-[14px] text-ink-secondary"
          >
            {repo.description}
          </span>
        )}
        {claimedByOther && (
          <span className="mt-1 block text-[14px] text-ink">
            {disableClaimed
              ? `Already ${repo.claimedByTeam}'s repository`
              : `Already ${repo.claimedByTeam}'s repository, so picking it joins that team`}
          </span>
        )}
        <span className="mt-1 block font-mono text-[12.5px] text-ink-faint">
          {repo.defaultBranch}
          {repo.pushedAt != null && <> · updated {formatTimeAgo(repo.pushedAt)}</>}
        </span>
      </span>
    </label>
  );
}

function compareReposByRecency(left: GithubRepo, right: GithubRepo): number {
  const leftPushedAt = left.pushedAt ?? Number.NEGATIVE_INFINITY;
  const rightPushedAt = right.pushedAt ?? Number.NEGATIVE_INFINITY;
  if (leftPushedAt !== rightPushedAt) return rightPushedAt - leftPushedAt;
  return left.fullName.localeCompare(right.fullName);
}
