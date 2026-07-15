import { ArrowDown01Icon, GitForkIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { GithubRepo } from "@cogworks/contracts/schema";
import { useId, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { formatTimeAgo } from "@/lib/format";
import { EASE_OUT } from "@/lib/motion";

/**
 * Enriched repository radio-card list — shared by Connect and Team settings.
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
  const [showAll, setShowAll] = useState(false);
  const reduceMotion = useReducedMotion();
  const olderRepositoriesId = useId();
  const olderRepositoriesRef = useRef<HTMLDivElement>(null);
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

      {showAll && olderRepos.length > 0 ? (
        <motion.div
          ref={olderRepositoriesRef}
          id={olderRepositoriesId}
          initial={
            reduceMotion
              ? false
              : { height: 0, opacity: 0, filter: "blur(2px)" }
          }
          animate={{ height: "auto", opacity: 1, filter: "blur(0px)" }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 0.22, ease: EASE_OUT }
          }
          className="overflow-hidden"
        >
          <div className="space-y-2 pt-2">
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
          </div>
        </motion.div>
      ) : null}

      {!showAll && olderRepos.length > 0 ? (
        <div className="relative pt-3">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-3 top-0 h-6 border border-rule-soft bg-paper-raised/65 blur-[1.5px]"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-6 top-1 h-6 border border-rule-soft bg-paper-raised/50 blur-[2px]"
          />
          <button
            type="button"
            aria-expanded="false"
            aria-controls={olderRepositoriesId}
            onClick={(event) => {
              setShowAll(true);
              if (event.detail === 0) {
                requestAnimationFrame(() => {
                  olderRepositoriesRef.current
                    ?.querySelector<HTMLInputElement>('input[type="radio"]')
                    ?.focus();
                });
              }
            }}
            className="u-pressable relative flex min-h-12 w-full items-center justify-between gap-4 border border-rule bg-paper-raised/85 px-4 py-2.5 text-left shadow-[0_2px_8px_rgb(28_38_55/0.06)] backdrop-blur-[3px] transition-colors duration-150 hover:border-ink-secondary hover:bg-paper-raised"
          >
            <span>
              <span className="block text-[13.5px] font-medium text-ink">
                See {olderRepos.length} more {olderRepos.length === 1 ? "repository" : "repositories"}
              </span>
              <span className="block font-mono text-[10.5px] text-ink-faint">
                Older repositories · newest first
              </span>
            </span>
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={16}
              strokeWidth={1.8}
              className="shrink-0 text-ink-faint"
              aria-hidden="true"
            />
          </button>
        </div>
      ) : null}
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
      className={`flex items-start gap-3 border bg-paper-raised px-4 py-3 transition-colors duration-150 ${
        disabled
          ? "cursor-not-allowed opacity-55"
          : picked
            ? "cursor-pointer border-ink"
            : "cursor-pointer border-rule hover:border-ink-secondary"
      }`}
    >
      <input
        type="radio"
        name="repository"
        checked={picked}
        disabled={disabled}
        onChange={() => onPick(repo)}
        className="mt-1 accent-[#c63d2f]"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate font-mono text-[13.5px] font-medium text-ink">
            {repo.fullName}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {repo.isFork && (
              <span className="flex items-center gap-1 font-mono text-[10px] tracking-[0.07em] text-ink-faint uppercase">
                <HugeiconsIcon icon={GitForkIcon} size={11} strokeWidth={1.8} aria-hidden="true" />
                fork
              </span>
            )}
            {isCurrent ? (
              <span className="font-mono text-[10px] tracking-[0.07em] text-verify-deep uppercase">
                current
              </span>
            ) : repo.claimedByTeam ? (
              <span className="font-mono text-[10px] tracking-[0.07em] text-ink-faint uppercase">
                team · {repo.claimedByTeam}
              </span>
            ) : null}
          </span>
        </span>
        {repo.description && (
          <span
            title={repo.description}
            className="mt-0.5 line-clamp-1 block text-[12.5px] text-ink-secondary"
          >
            {repo.description}
          </span>
        )}
        <span className="mt-1 block font-mono text-[11px] text-ink-faint">
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
