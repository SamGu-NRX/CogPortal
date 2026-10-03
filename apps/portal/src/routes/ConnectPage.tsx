import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { motion, useReducedMotion } from "motion/react";
import type { CohortTeam, GithubRepo } from "@cogworks/contracts/schema";
import { CornerBrackets } from "@/components/Brackets";
import { Button, buttonClass } from "@/components/Button";
import { DroppedLinkNotice } from "@/components/DroppedLinkNotice";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { GrantAccess } from "@/components/GrantAccess";
import { MemberAvatar } from "@/components/MemberAvatar";
import { OnboardingPath } from "@/components/OnboardingPath";
import { RepoPicker } from "@/components/RepoPicker";
import { Veil } from "@/components/Veil";
import { ApiRequestError } from "@/lib/api";
import { EASE_OUT } from "@/lib/motion";
import {
  useCohortTeams,
  useConnectRepo,
  useJoinTeam,
  useRepositories,
  useSession,
} from "@/lib/queries";
import { clearLeftTeam, peekLeftTeam, subscribeLeftTeam } from "@/lib/left-team";

const JOIN_TEAMS_VISIBLE = 5;
// Folding one or two teams away costs a press to save a row or two, and the
// fold's own row is nearly as tall as what it hides, so a short list shows whole.
const JOIN_TEAMS_MIN_FOLDED = 3;

type WizardStep = "choice" | "join" | "start";

/** Router state SetupPage reads once to acknowledge the moment the team
 *  became real. The shape is the hand-off contract with the setup lane. */
export type SetupArrival = { arrivedFrom: "created" | "joined"; teamName: string };

/** Marks a history entry this page pushed, so the on-page back link can pop
 *  it instead of stacking a second copy of the choice screen. */
type WizardEntry = { wizard: true };

function isWizardEntry(state: unknown): state is WizardEntry {
  return typeof state === "object" && state !== null && "wizard" in state;
}

function readStep(value: string | null): WizardStep | null {
  return value === "join" || value === "start" ? value : null;
}

/**
 * What the Leave on the Team page just did, for the person it brought here
 * (useLeaveTeam). Shown on this arrival only: the note is cleared once drawn,
 * so a later visit to /connect says nothing.
 */
function LeftTeamNotice({ className = "" }: { className?: string }) {
  const pending = useSyncExternalStore(subscribeLeftTeam, peekLeftTeam);
  // Kept here once seen, since the note itself is cleared on sight.
  const [left, setLeft] = useState(peekLeftTeam);
  useEffect(() => {
    if (!pending) return;
    setLeft(pending);
    clearLeftTeam();
  }, [pending]);
  if (!left) return null;
  return (
    <div
      role="status"
      className={`rounded-control border-l-2 border-ink bg-paper-raised px-4 py-3 text-[14px] leading-[1.55] text-ink-secondary ${className}`}
    >
      <p className="font-semibold break-words text-ink">
        {left.alreadyLeft ? `You'd already left ${left.name}` : `You left ${left.name}`}
      </p>
      <p className="mt-1">
        {left.alreadyLeft
          ? "Nothing changed this time; another tab or request had already taken you off it."
          : "Its runs and results stay with the team. If GitHub still gives you write access to its repository, you can join it again below."}
      </p>
    </div>
  );
}

/**
 * A short wizard, one decision per screen. Most students join a team someone
 * else started; the first one in forks the template and creates it. The
 * repository is the team either way.
 *
 * The chosen path lives in the URL (?path=join|start), so a phone's back
 * gesture returns to the choice instead of leaving the page, and a reload
 * keeps the student where they were.
 */
export function ConnectPage() {
  const { data: session } = useSession();
  const cohortTeams = useCohortTeams();
  const reduceMotion = useReducedMotion();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef<WizardStep | null>(null);
  // Owned here, not in the path components: once a join/create succeeds the
  // refreshed session gains a team, and this guard would otherwise redirect
  // to /dashboard, unmounting the mutation's onSuccess before it can
  // navigate to /setup. Suppress the redirect while we're mid-setup.
  const join = useJoinTeam();
  const connect = useConnectRepo();
  const settingUp =
    join.isPending || join.isSuccess || connect.isPending || connect.isSuccess;
  // Shared with StartPath (same query key). Read here as well because a
  // repository the student can already see that belongs to a team is the
  // best evidence of which team is theirs. It only suggests, so nothing here
  // waits for it, and it switches off once a join starts: the mutations
  // refetch every active query before navigating, and a stalled GitHub
  // listing must not hold a successful join on this page.
  const repos = useRepositories(!settingUp);

  const teams = cohortTeams.data ?? [];
  const hasTeams = teams.length > 0;
  // No teams yet means there is nothing to join; skip the choice screen.
  const step: WizardStep = hasTeams ? (readStep(params.get("path")) ?? "choice") : "start";
  const loading = cohortTeams.isPending;

  // A step change replaces the whole screen, so focus follows it to the new
  // heading; otherwise a keyboard user is left on a button that no longer
  // exists. Not on first arrival, where the page's own load order is right.
  useEffect(() => {
    if (loading) return;
    if (shownStep.current !== null && shownStep.current !== step) {
      headingRef.current?.focus({ preventScroll: true });
    }
    shownStep.current = step;
  }, [step, loading]);

  if (session?.team && !settingUp) return <Navigate to="/dashboard" replace />;

  if (loading) {
    return (
      <div className="page [--measure:31rem]">
        <OnboardingPath current="team" className="max-w-[31rem]" />
        <LoadingMark label="Checking the cohort" />
      </div>
    );
  }

  // An errored teams query must not masquerade as "no teams yet"; that
  // would quietly funnel everyone into creating duplicates.
  const teamsUnknown = cohortTeams.isError;
  const template = session?.auth.templateRepo ?? null;
  const visibleRepos = new Set((repos.data ?? []).map((repo) => repo.fullName));
  const likely = teams.filter((team) => visibleRepos.has(team.repo.fullName));

  const choose = (next: "join" | "start") =>
    setParams({ path: next }, { state: { wizard: true } satisfies WizardEntry });
  const backToChoice = () => {
    if (isWizardEntry(location.state)) navigate(-1);
    else setParams({}, { replace: true });
  };

  // One join at a time: only the pressed row disables, so the rest of the
  // list stays pressable and a second press has to be refused here.
  const joinTeam = (team: CohortTeam) => {
    if (join.isPending) return;
    join.mutate(team.id, {
      onSuccess: () =>
        navigate("/setup", {
          replace: true,
          state: { arrivedFrom: "joined", teamName: team.name } satisfies SetupArrival,
        }),
    });
  };

  const back =
    hasTeams && step !== "choice" ? (
      <button
        type="button"
        onClick={backToChoice}
        className="u-pressable -ml-2 mb-3 inline-flex min-h-11 items-center gap-1 rounded-control px-2 text-[14px] font-semibold text-ink-secondary hover:text-ink"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.8} aria-hidden="true" />
        Back
      </button>
    ) : null;

  const title = "text-[clamp(2rem,1.5rem+2vw,2.5rem)] text-ink outline-none";

  return (
    <div className="page [--measure:31rem]">
      <OnboardingPath current="team" className="max-w-[31rem]" />
      {/* Outside the keyed step, so the notice survives moving between
          steps; it is consumed on first render and would not come back. */}
      <DroppedLinkNotice className="mt-8 max-w-[31rem]" />
      <LeftTeamNotice className="mt-8 max-w-[31rem]" />
      <motion.div
        key={step}
        className="mt-10"
        initial={reduceMotion ? false : { opacity: 0, transform: "translateY(6px)" }}
        animate={{ opacity: 1, transform: "translateY(0px)" }}
        transition={{ duration: 0.2, ease: EASE_OUT }}
      >
        {step === "choice" ? (
          <>
            <header className="max-w-[31rem]">
              <h1 ref={headingRef} tabIndex={-1} className={title}>
                Join or start your team
              </h1>
            </header>
            <div className="mt-8 max-w-[31rem]">
              {/* Can land after the choices when GitHub is slower than the
                  cohort list; the rise makes the late arrival legible. */}
              {likely.length > 0 && (
                <section aria-labelledby="likely-team" className="anim-rise relative mb-9 rounded-surface bg-paper-raised p-5">
                  <CornerBrackets size={12} thickness={1.5} />
                  <h2 id="likely-team" className="u-label">
                    {likely.length === 1 ? "Probably your team" : "Teams whose repository you can see"}
                  </h2>
                  <ul role="list" className="mt-1">
                    {likely.map((team) => (
                      <TeamRow
                        key={team.id}
                        team={team}
                        join={join}
                        onJoin={() => joinTeam(team)}
                        primary
                      />
                    ))}
                  </ul>
                </section>
              )}

              {likely.length > 0 && (
                <h2 className="u-label mb-3">Not the right team?</h2>
              )}
              <div className="space-y-3">
                <ChoiceCard
                  onSelect={() => choose("join")}
                  label="Join a team someone already started"
                />
                <ChoiceCard
                  onSelect={() => choose("start")}
                  label="Start a new team"
                  hint={
                    template
                      ? "Connect your fork of the course template."
                      : "Connect a public repository you can push to."
                  }
                />
              </div>
            </div>
          </>
        ) : step === "join" ? (
          <>
            <header className="max-w-[31rem]">
              {back}
              <h1 ref={headingRef} tabIndex={-1} className={title}>
                Join your team
              </h1>
            </header>
            <div className="mt-6 max-w-[31rem]">
              <JoinPath
                teams={teams}
                join={join}
                onJoin={joinTeam}
                onStartInstead={() => setParams({ path: "start" }, { replace: true, state: location.state })}
              />
            </div>
          </>
        ) : (
          <>
            <header className="max-w-[31rem]">
              {back}
              <h1 ref={headingRef} tabIndex={-1} className={title}>
                Start your team
              </h1>
              <p className="mt-3 text-[16px] leading-[1.6] text-ink-secondary">
                {template ? (
                  <>
                    Fork{" "}
                    <a
                      href={`https://github.com/${template}`}
                      target="_blank"
                      rel="noreferrer"
                      className="u-link font-mono text-[14px] break-all"
                    >
                      {template}
                      <span className="sr-only"> (opens GitHub)</span>
                    </a>{" "}
                    (keep it public), then pick your fork below.
                  </>
                ) : (
                  "Pick the public repository your team will work in."
                )}
              </p>
            </header>
            {teamsUnknown && (
              <div className="mt-6 max-w-[31rem]">
                <QueryError
                  error={cohortTeams.error}
                  retry={() => void cohortTeams.refetch()}
                />
                <p className="mt-2 text-[13.5px] text-ink-secondary">
                  Joining is hidden until the team list loads. Starting a team still works.
                </p>
              </div>
            )}
            <div className="mt-8 max-w-[31rem]">
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
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group u-pressable relative flex w-full items-center gap-4 rounded-surface border border-rule bg-paper-raised px-5 py-4 text-left transition-[border-color] duration-150 hover:border-ink-secondary"
    >
      <span className="absolute inset-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
        <CornerBrackets size={9} thickness={2} inset={-1} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-serif text-[18px] font-semibold text-ink">{label}</span>
        {hint && <span className="mt-1 block text-[14px] leading-[1.5] text-ink-secondary">{hint}</span>}
      </span>
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        size={18}
        strokeWidth={1.8}
        className="shrink-0 text-ink-faint transition-colors duration-150 group-hover:text-ink"
        aria-hidden="true"
      />
    </button>
  );
}

/* ── Join a team ──────────────────────────────────────────────────────── */

function matches(team: CohortTeam, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  if (!q) return true;
  return [
    team.name,
    team.repo.fullName,
    ...team.members.flatMap((member) => [member.login, member.name ?? ""]),
  ].some((field) => field.toLowerCase().includes(q));
}

function JoinPath({
  teams,
  join,
  onJoin,
  onStartInstead,
}: {
  teams: CohortTeam[];
  join: ReturnType<typeof useJoinTeam>;
  onJoin: (team: CohortTeam) => void;
  onStartInstead: () => void;
}) {
  const { data: session } = useSession();
  const [query, setQuery] = useState("");
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const searchable = teams.length > JOIN_TEAMS_VISIBLE;
  const filtering = query.trim().length > 0;
  const found = teams.filter((team) => matches(team, query));

  const row = (team: CohortTeam) => (
    <TeamRow key={team.id} team={team} join={join} onJoin={() => onJoin(team)} />
  );

  // While filtering every match shows: folding search results away would
  // hide the answer to the question just asked.
  const foldAt =
    filtering || found.length - JOIN_TEAMS_VISIBLE < JOIN_TEAMS_MIN_FOLDED ? found.length : JOIN_TEAMS_VISIBLE;
  const visible = found.slice(0, foldAt);
  const folded = found.slice(foldAt);

  return (
    <div className="mt-6">
      {searchable && (
        <div className="mb-5">
          <label htmlFor={searchId} className="u-label block">
            Find your team
          </label>
          <div className="relative mt-2">
            <HugeiconsIcon
              icon={Search01Icon}
              size={16}
              strokeWidth={1.8}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint"
              aria-hidden="true"
            />
            <input
              ref={searchRef}
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  setQuery("");
                }
              }}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby={`${searchId}-count`}
              className="u-field pr-11 pl-9 [&::-webkit-search-cancel-button]:appearance-none"
              placeholder="Team name, teammate, or repository"
            />
            {/* Our own clear, because the native one is a blue glyph on
                WebKit and missing on Firefox; Escape does the same. */}
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                className="absolute top-0 right-0 flex size-11 items-center justify-center rounded-control text-ink-faint hover:text-ink"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.8} aria-hidden="true" />
                <span className="sr-only">Clear the search</span>
              </button>
            )}
          </div>
          <p id={`${searchId}-count`} aria-live="polite" className="mt-2 text-[13px] text-ink-faint">
            {filtering
              ? `${found.length} of ${teams.length} ${teams.length === 1 ? "team" : "teams"} match`
              : `${teams.length} teams in ${session?.cohort?.name ?? "the cohort"}`}
          </p>
        </div>
      )}

      {found.length === 0 ? (
        <div className="border-y border-rule-soft py-6">
          <p className="text-[15px] text-ink">
            No team matches <span className="font-mono text-[14px]">{query.trim()}</span>.
          </p>
        </div>
      ) : (
        <>
          <ul role="list" className="border-t border-rule-soft">
            {visible.map(row)}
          </ul>
          {folded.length > 0 && (
            <Veil
              count={folded.length}
              moreLabel={`See ${folded.length} more ${folded.length === 1 ? "team" : "teams"}`}
              fewerLabel="Show fewer teams"
              detail={session?.cohort ? `Every team in ${session.cohort.name}` : "Every team in the cohort"}
              focusSelector="button"
            >
              <ul role="list">{folded.map(row)}</ul>
            </Veil>
          )}
        </>
      )}

      <p className="mt-6 text-[14px] text-ink-secondary">
        Nobody on your team has started it yet?{" "}
        <button type="button" onClick={onStartInstead} className="u-link font-semibold">
          Start it yourself
        </button>
      </p>
    </div>
  );
}

/** The server's answer when a membership exists that this page never saw. */
function isAlreadyOnTeam(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === "already_on_team";
}

/**
 * A join or a new team refused because the student is already on a team,
 * made in another window, on another device or by staff after this page
 * loaded. Nothing here can show that team: the session this page holds says
 * none. A full page load (a plain link, not a router Link) drops what this
 * page cached and reads where they stand now.
 */
function AlreadyOnTeamNotice({ className = "" }: { className?: string }) {
  return (
    <div role="alert" className={`rounded-control border-l-2 border-detect bg-detect-wash px-3 py-2 text-[14px] leading-[1.5] text-detect-deep ${className}`}>
      <p>You're already on a team; this page was opened before you joined it.</p>
      <a href="/team" className={buttonClass("ghost", "mt-2")}>
        Open your current team
      </a>
    </div>
  );
}

function joinErrorMessage(error: unknown): string | null {
  if (error instanceof ApiRequestError) {
    // A team deleted after the list loaded. The server's "Team not found."
    // reads like the student mistyped something.
    if (error.code === "not_found") {
      return "This team was removed after the list loaded. Reload the page to see the current teams.";
    }
    return error.message;
  }
  return error ? "Joining failed. Try again." : null;
}

/**
 * A team as a row: who is on it is what a student recognises, so the members
 * are named in text rather than left to avatars and a count.
 */
function TeamRow({
  team,
  join,
  onJoin,
  primary = false,
}: {
  team: CohortTeam;
  join: ReturnType<typeof useJoinTeam>;
  onJoin: () => void;
  primary?: boolean;
}) {
  // The mutation is shared by every row, so the row that asked is the one
  // whose id the mutation carries. Only it shows the pulse and the refusal;
  // every other row stays pressable, because the usual refusal (no push
  // access yet) often means the student pressed the wrong team.
  const mine = join.variables === team.id;
  const busy = join.isPending && mine;
  const settled = !join.isPending && mine;
  const alreadyOnTeam = settled && isAlreadyOnTeam(join.error);
  const message = settled && !alreadyOnTeam ? joinErrorMessage(join.error) : null;

  return (
    <li className={primary ? "pt-2" : "border-b border-rule-soft py-4"}>
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-serif text-[18px] font-semibold text-ink">{team.name}</h3>
          <Members members={team.members} />
          <p className="mt-1 truncate font-mono text-[12.5px] text-ink-faint">{team.repo.fullName}</p>
        </div>
        <Button
          type="button"
          variant={primary ? "primary" : "ghost"}
          busy={busy}
          onClick={onJoin}
          className="shrink-0"
          aria-label={`Join ${team.name}`}
        >
          Join
        </Button>
      </div>

      {alreadyOnTeam && <AlreadyOnTeamNotice className="mt-3" />}
      {message && (
        <p role="alert" className="mt-3 rounded-control border-l-2 border-detect bg-detect-wash px-3 py-2 text-[14px] leading-[1.5] text-detect-deep">
          {message}
        </p>
      )}
    </li>
  );
}

function Members({ members }: { members: CohortTeam["members"] }) {
  if (members.length === 0) {
    return <p className="mt-1 text-[14px] text-ink-faint">Nobody has joined yet</p>;
  }
  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  return (
    <p className="mt-1.5 flex min-w-0 items-center gap-2 text-[14px] text-ink-secondary">
      <span className="flex shrink-0 -space-x-1">
        {shown.map((member) => (
          <MemberAvatar
            key={member.login}
            login={member.login}
            avatarUrl={member.avatarUrl}
            className="size-5 ring-2 ring-paper-raised"
          />
        ))}
      </span>
      <span className="min-w-0 truncate">
        {shown.map((member) => `@${member.login}`).join(", ")}
        {extra > 0 && ` and ${extra} more`}
      </span>
    </p>
  );
}

/* ── Start a team ─────────────────────────────────────────────────────── */

function StartPath({ connect }: { connect: ReturnType<typeof useConnectRepo> }) {
  const repos = useRepositories();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<GithubRepo | null>(null);
  // What the student typed, if anything. The repository's own name is the
  // suggestion and lives in the placeholder: prefilling it as a value made
  // typing append to it ("Face FinderVideo QA Team").
  const [teamName, setTeamName] = useState("");

  const creating = Boolean(selected && !selected.claimedByTeam);
  const suggestion = selected ? defaultTeamName(selected.name) : "";
  const finalName = teamName.trim() || suggestion;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || connect.isPending) return;
    const claimedBy = selected.claimedByTeam;
    if (!claimedBy && !finalName) return;
    const arrival: SetupArrival = claimedBy
      ? { arrivedFrom: "joined", teamName: claimedBy }
      : { arrivedFrom: "created", teamName: finalName };
    connect.mutate(
      { fullName: selected.fullName, teamName: claimedBy ? undefined : finalName },
      { onSuccess: () => navigate("/setup", { replace: true, state: arrival }) },
    );
  };

  return (
    <form onSubmit={submit}>
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
            onPick={setSelected}
            initialVisibleCount={6}
          />
          <GrantAccess hasRepos />
        </>
      )}

      {/* Second step appears only once a repo is chosen. */}
      {creating && (
        <div className="anim-rise mt-7">
          <label htmlFor="team-name" className="u-label block">
            Team name
          </label>
          <input
            id="team-name"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            maxLength={60}
            autoComplete="off"
            aria-describedby="team-name-help"
            className="u-field mt-2"
            placeholder={suggestion}
          />
          <p id="team-name-help" className="mt-2 text-[13.5px] leading-[1.5] text-ink-secondary">
            Shown on the public leaderboard. Leave it blank to use{" "}
            <span className="font-semibold text-ink">{suggestion}</span>; an admin on the GitHub
            repository can rename it later.
          </p>
        </div>
      )}

      {isAlreadyOnTeam(connect.error) ? (
        <AlreadyOnTeamNotice className="mt-4" />
      ) : connect.error && (
        <p role="alert" className="mt-4 rounded-control border-l-2 border-detect bg-detect-wash px-3 py-2 text-[14px] leading-[1.5] text-detect-deep">
          {connect.error instanceof ApiRequestError
            ? connect.error.message
            : "Connecting failed. Try again."}
        </p>
      )}

      {repos.data && repos.data.length > 0 && (
        <Button
          type="submit"
          className="mt-6 h-12 w-full"
          busy={connect.isPending}
          disabled={!selected}
        >
          {!selected
            ? "Choose a repository above"
            : selected.claimedByTeam
              ? `Join ${selected.claimedByTeam}`
              : `Create ${finalName}`}
        </Button>
      )}
    </form>
  );
}

/** Nothing to pick yet: the three things that make a fork show up, with the
 *  fork itself one press away. */
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
    <div>
      <p className="text-[15px] text-ink">
        No repositories are visible to the portal yet.
      </p>
      <ol role="list" className="mt-5 space-y-6">
        <ForkStep n={1} title={template ? "Fork the course template" : "Pick a public repository"}>
          {template ? (
            <>
              <p>Keep it public, under your account or your team's organization.</p>
              <a
                href={`https://github.com/${template}/fork`}
                target="_blank"
                rel="noreferrer"
                className={buttonClass("primary", "mt-3")}
              >
                Fork {template}
                <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={1.8} aria-hidden="true" />
                <span className="sr-only"> (opens GitHub)</span>
              </a>
            </>
          ) : (
            <p>Use one your team already has, or create one on GitHub.</p>
          )}
        </ForkStep>
        <ForkStep n={2} title="Let the portal read it">
          <p>Install the portal's GitHub app on the account that owns the repository. It can read code and never writes.</p>
          <GrantAccess hasRepos={false} />
        </ForkStep>
        <ForkStep n={3} title="Check again">
          <p>Your repository appears here once the app can see it.</p>
          <Button
            type="button"
            variant="ghost"
            busy={refetching}
            onClick={onCheckAgain}
            className="mt-3"
          >
            Check again
          </Button>
        </ForkStep>
      </ol>
    </div>
  );
}

function ForkStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2">
      <span aria-hidden="true" className="u-tnum pt-px font-serif text-[16px] font-semibold text-ink-faint italic">
        {n}.
      </span>
      <div>
        <h3 className="text-[17px] text-ink">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h3>
        <div className="mt-1 text-[14.5px] leading-[1.55] text-ink-secondary">{children}</div>
      </div>
    </li>
  );
}

function defaultTeamName(repoName: string): string {
  return repoName
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .slice(0, 60);
}
