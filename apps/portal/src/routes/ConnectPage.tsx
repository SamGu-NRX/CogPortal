import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { motion, useReducedMotion } from "motion/react";
import type { CohortTeam, GithubRepo } from "@cogworks/contracts/schema";
import { CornerBrackets } from "@/components/Brackets";
import { Button } from "@/components/Button";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { GrantAccess } from "@/components/GrantAccess";
import { RepoPicker } from "@/components/RepoPicker";
import { Veil } from "@/components/Veil";
import { WalkthroughVideo } from "@/components/WalkthroughVideo";
import { ApiRequestError } from "@/lib/api";
import { EASE_OUT } from "@/lib/motion";
import {
  useCohortTeams,
  useConnectRepo,
  useJoinTeam,
  useRepositories,
  useSession,
} from "@/lib/queries";

const JOIN_TEAMS_VISIBLE = 5;

// TODO: Set the versioned asset base after the onboarding-media exports land.
const GITHUB_TEAM_VIDEO: string | null = null;

type WizardStep = "choice" | "join" | "start";

/**
 * A short wizard, one decision per screen. Most students join a team someone
 * else started; the first one in forks the template and creates it. The
 * repository is the team either way.
 */
export function ConnectPage() {
  const { data: session } = useSession();
  const cohortTeams = useCohortTeams();
  const reduceMotion = useReducedMotion();
  const [chosen, setChosen] = useState<WizardStep | null>(null);
  // Owned here, not in the path components: once a join/create succeeds the
  // refreshed session gains a team, and this guard would otherwise redirect
  // to /dashboard, unmounting the mutation's onSuccess before it can
  // navigate to /setup. Suppress the redirect while we're mid-setup.
  const join = useJoinTeam();
  const connect = useConnectRepo();
  const settingUp =
    join.isPending || join.isSuccess || connect.isPending || connect.isSuccess;

  if (session?.team && !settingUp) return <Navigate to="/dashboard" replace />;

  if (cohortTeams.isPending) {
    return (
      <div className="mx-auto w-full max-w-lg py-14">
        <LoadingMark label="Checking the cohort" />
      </div>
    );
  }

  const teams = cohortTeams.data ?? [];
  const hasTeams = teams.length > 0;
  // No teams yet means there is nothing to join; skip the choice screen.
  const step: WizardStep = hasTeams ? (chosen ?? "choice") : "start";
  // An errored teams query must not masquerade as "no teams yet"; that
  // would quietly funnel everyone into creating duplicates.
  const teamsUnknown = cohortTeams.isError;

  const back =
    hasTeams && step !== "choice" ? (
      <button
        type="button"
        onClick={() => setChosen("choice")}
        className="u-pressable mb-4 inline-flex min-h-9 items-center gap-1 font-mono text-[11px] tracking-[0.09em] text-ink-secondary uppercase hover:text-ink"
      >
        <HugeiconsIcon
          icon={ArrowLeft01Icon}
          size={14}
          strokeWidth={1.8}
          aria-hidden="true"
        />
        Both options
      </button>
    ) : null;

  return (
    <div className="mx-auto w-full max-w-lg py-14">
      <motion.div
        key={step}
        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: EASE_OUT }}
      >
        {step === "choice" ? (
          <>
            <h1 className="text-3xl">Set up your team</h1>
            <p className="mt-2 text-[14px] text-ink-secondary">
              You do this once. The repository is the team; everyone with
              write access shares its attempts.
            </p>
            <div className="mt-8 space-y-3">
              <ChoiceCard
                onSelect={() => setChosen("join")}
                label="Join a team"
                hint={`Someone on your team went first. Find them among the cohort's ${teams.length} ${teams.length === 1 ? "team" : "teams"}.`}
              />
              <ChoiceCard
                onSelect={() => setChosen("start")}
                label="Start a team"
                hint="Fork the course template and connect your fork. You'll be the team's creator."
              />
            </div>
          </>
        ) : step === "join" ? (
          <>
            {back}
            <h1 className="text-3xl">Join your team</h1>
            <p className="mt-2 text-[14px] text-ink-secondary">
              Joining checks your GitHub access to the team's fork;
              collaborators get in instantly.
            </p>
            <div className="mt-7">
              <JoinPath teams={teams} join={join} />
            </div>
          </>
        ) : (
          <>
            {back}
            <h1 className="text-3xl">Start a team</h1>
            <p className="mt-2 text-[14px] text-ink-secondary">
              Your team runs from a public fork of{" "}
              {session?.auth.templateRepo ? (
                <code className="text-[12.5px] text-ink">{session.auth.templateRepo}</code>
              ) : (
                "the course template"
              )}
              . Fork it, connect it, and the team exists.
            </p>
            {teamsUnknown && (
              <div className="mt-6">
                <QueryError
                  error={cohortTeams.error}
                  retry={() => void cohortTeams.refetch()}
                />
                <p className="mt-2 text-[12.5px] text-ink-faint">
                  We couldn't check the cohort's teams, so joining is hidden
                  until this loads. Starting a team still works.
                </p>
              </div>
            )}
            <div className="mt-7">
              <StartPath connect={connect} />
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}

/** One decision per card. The detection frame marks the option under the
 *  pointer: the instrument is looking where you are. */
function ChoiceCard({
  onSelect,
  label,
  hint,
}: {
  onSelect: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group u-pressable relative flex w-full items-center gap-4 border border-rule bg-paper-raised px-5 py-4 text-left transition-colors duration-150 hover:border-ink-secondary focus-visible:border-ink"
    >
      <span className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
        <CornerBrackets size={9} thickness={2} inset={-1} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-serif text-[17px] font-semibold text-ink">{label}</span>
        <span className="mt-0.5 block text-[13px] leading-snug text-ink-secondary">{hint}</span>
      </span>
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        size={16}
        strokeWidth={1.8}
        className="shrink-0 text-ink-faint transition-colors duration-150 group-hover:text-ink"
        aria-hidden="true"
      />
    </button>
  );
}

/* ── Join a team ──────────────────────────────────────────────────────── */

function JoinPath({
  teams,
  join,
}: {
  teams: CohortTeam[];
  join: ReturnType<typeof useJoinTeam>;
}) {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const attempt = (team: CohortTeam) => {
    if (join.isPending) return;
    setJoiningId(team.id);
    join.mutate(team.id, {
      onSuccess: () =>
        navigate("/setup", { replace: true, state: { entry: "joined" } }),
    });
  };

  const visible = teams.slice(0, JOIN_TEAMS_VISIBLE);
  const folded = teams.slice(JOIN_TEAMS_VISIBLE);

  const card = (team: CohortTeam) => (
    <TeamCard
      key={team.id}
      team={team}
      busy={join.isPending && joiningId === team.id}
      error={!join.isPending && joiningId === team.id ? join.error : null}
      onJoin={() => attempt(team)}
    />
  );

  return (
    <div>
      <div className="space-y-2">{visible.map(card)}</div>
      {folded.length > 0 && (
        <Veil
          count={folded.length}
          moreLabel={`See ${folded.length} more ${folded.length === 1 ? "team" : "teams"}`}
          fewerLabel="Show fewer teams"
          detail={
            session?.cohort ? `Every team in ${session.cohort.name}` : "Every team in the cohort"
          }
          focusSelector="button"
        >
          {folded.map(card)}
        </Veil>
      )}
      <p className="mt-4 text-[12.5px] text-ink-faint">
        Not a collaborator on the fork yet? Ask a teammate to add you on
        GitHub, or the team's creator can add you from Team settings.
      </p>
    </div>
  );
}

function TeamCard({
  team,
  busy,
  error,
  onJoin,
}: {
  team: CohortTeam;
  busy: boolean;
  error: unknown;
  onJoin: () => void;
}) {
  const message =
    error instanceof ApiRequestError
      ? error.message
      : error
        ? "Joining failed. Try again."
        : null;

  return (
    <div className="border border-rule bg-paper-raised px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="min-w-0 truncate font-serif text-[17px] font-semibold text-ink">
          {team.name}
        </h3>
        <span className="shrink-0 font-mono text-[10.5px] tracking-[0.07em] text-ink-faint uppercase">
          {team.members.length} {team.members.length === 1 ? "member" : "members"}
        </span>
      </div>
      {team.description && (
        <p className="mt-1 line-clamp-2 text-[13px] text-ink-secondary">{team.description}</p>
      )}
      <p className="mt-1 truncate font-mono text-[11px] text-ink-faint">{team.repo.fullName}</p>

      <div className="mt-3 flex items-center justify-between gap-3">
        <MemberStrip members={team.members} />
        <Button
          type="button"
          variant="ghost"
          busy={busy}
          onClick={onJoin}
          className="shrink-0 !min-h-9 px-4 text-[12.5px]"
        >
          Join
        </Button>
      </div>

      {message && (
        <p
          role="alert"
          className="mt-3 border-t border-rule-soft pt-2.5 text-[12.5px] leading-relaxed text-detect-deep"
        >
          {message}
        </p>
      )}
    </div>
  );
}

function MemberStrip({ members }: { members: CohortTeam["members"] }) {
  const shown = members.slice(0, 5);
  const extra = members.length - shown.length;
  return (
    <span className="flex min-w-0 items-center">
      <span className="flex -space-x-1.5">
        {shown.map((member) =>
          member.avatarUrl ? (
            <img
              key={member.login}
              src={member.avatarUrl}
              alt=""
              title={`@${member.login}`}
              className="size-6 rounded-[2px] border border-paper-raised"
            />
          ) : (
            <span
              key={member.login}
              aria-hidden="true"
              title={`@${member.login}`}
              className="flex size-6 items-center justify-center rounded-[2px] border border-paper-raised bg-paper-sunken font-mono text-[10px] text-ink-secondary uppercase"
            >
              {member.login[0]}
            </span>
          ),
        )}
      </span>
      {extra > 0 && (
        <span className="ml-2 font-mono text-[10.5px] text-ink-faint">+{extra}</span>
      )}
      <span className="sr-only">
        Members: {members.map((member) => `@${member.login}`).join(", ")}
      </span>
    </span>
  );
}

/* ── Start a team ─────────────────────────────────────────────────────── */

function StartPath({ connect }: { connect: ReturnType<typeof useConnectRepo> }) {
  const repos = useRepositories();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<GithubRepo | null>(null);
  const [teamName, setTeamName] = useState("");

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
      {
        onSuccess: () =>
          navigate("/setup", {
            replace: true,
            state: { entry: creating ? "created" : "joined" },
          }),
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <OrganizationPrimer />
      {repos.isPending ? (
        <LoadingMark label="Listing repositories" />
      ) : repos.isError ? (
        <QueryError error={repos.error} retry={() => void repos.refetch()} />
      ) : repos.data.length === 0 ? (
        <ForkSteps refetching={repos.isRefetching} onCheckAgain={() => void repos.refetch()} />
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
  );
}

function OrganizationPrimer() {
  return (
    <aside className="mb-6 border border-rule bg-paper-sunken px-4 py-4" aria-labelledby="org-primer-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="u-kicker">Recommended team home</p>
          <h2 id="org-primer-title" className="mt-1 font-serif text-[17px] font-semibold text-ink">
            Use a free GitHub organization
          </h2>
        </div>
        <a
          href="https://github.com/organizations/plan"
          target="_blank"
          rel="noreferrer"
          className="u-pressable inline-flex min-h-9 items-center gap-1.5 font-mono text-[11px] tracking-[0.07em] text-ink-secondary uppercase underline decoration-rule underline-offset-4 hover:text-ink hover:decoration-ink"
        >
          Create organization
          <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} strokeWidth={1.8} aria-hidden="true" />
        </a>
      </div>
      <ol className="mt-3 grid gap-2 text-[12.5px] leading-relaxed text-ink-secondary sm:grid-cols-3">
        <li><span className="font-mono text-[10px] text-ink-faint">01</span><br />Create the organization and keep the free plan.</li>
        <li><span className="font-mono text-[10px] text-ink-faint">02</span><br />Invite teammates; keep two owners for recovery.</li>
        <li><span className="font-mono text-[10px] text-ink-faint">03</span><br />Fork the starter into that organization.</li>
      </ol>
      {GITHUB_TEAM_VIDEO && (
        <WalkthroughVideo
          base={GITHUB_TEAM_VIDEO}
          title="Create the team organization and fork the starter on GitHub"
          caption="The same three steps, recorded."
        />
      )}
      <p className="mt-3 text-[11.5px] text-ink-faint">
        Working alone? A personal fork is supported. The organization is a recommendation, not a gate.
      </p>
    </aside>
  );
}

/** Empty state as protocol, not apology: three short steps to a fork, with
 *  the fork itself one click away. */
function ForkSteps({
  refetching,
  onCheckAgain,
}: {
  refetching: boolean;
  onCheckAgain: () => void;
}) {
  const { data: session } = useSession();
  const template = session?.auth.templateRepo;

  return (
    <div className="border border-rule bg-paper-raised">
      <p className="border-b border-rule-soft px-5 py-3.5 text-[14px] text-ink">
        No repositories are visible yet. Three short steps:
      </p>
      <ol className="divide-y divide-rule-soft">
        <li className="flex flex-wrap items-center gap-4 px-5 py-3.5">
          <span className="font-mono text-[11px] text-ink-faint">01</span>
          <span className="flex-1 text-[13.5px] text-ink-secondary">
            Fork the template on GitHub. Keep the fork public; the benchmark
            runs from it.
          </span>
          <Button
            type="button"
            onClick={() =>
              window.open(
                template
                  ? `https://github.com/${template}/fork`
                  : "https://github.com",
                "_blank",
                "noreferrer",
              )
            }
            className="!min-h-9 shrink-0 px-4 text-[12.5px]"
          >
            Fork {template ?? "the template"}
            <HugeiconsIcon
              icon={ArrowUpRight01Icon}
              size={13}
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </Button>
        </li>
        <li className="flex items-baseline gap-4 px-5 py-3">
          <span className="font-mono text-[11px] text-ink-faint">02</span>
          <span className="text-[13.5px] text-ink-secondary">
            Let the app see your fork.
            <GrantAccess hasRepos={false} />
          </span>
        </li>
        <li className="flex flex-wrap items-center gap-4 px-5 py-3">
          <span className="font-mono text-[11px] text-ink-faint">03</span>
          <span className="flex-1 text-[13.5px] text-ink-secondary">
            It shows up here.
          </span>
          <Button
            type="button"
            variant="ghost"
            busy={refetching}
            onClick={onCheckAgain}
            className="!min-h-9 px-4 text-[12.5px]"
          >
            Check again
          </Button>
        </li>
      </ol>
    </div>
  );
}

function defaultTeamName(repoName: string): string {
  return repoName
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .slice(0, 60);
}
