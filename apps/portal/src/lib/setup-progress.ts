import { isBenchmarkScopedStep, type Benchmark, type SetupStep } from "@cogworks/contracts/schema";
import { COGBENCH_SOURCE, benchmarkPackage } from "./benchmark-packages";

/**
 * How far setup has got, and the commands that measure it.
 *
 * The setup page and the dashboard nudge both report progress, and they used
 * to count different things: the nudge counted milestones (a team exists, a
 * teammate exists) while the page counted commands. Two "of 6" figures that
 * disagreed read as a bug. Both now build the same array here and count it, so
 * a student can literally count the ticks and get the number in the masthead.
 *
 * Everything counted is something CogPortal observed: CLI evidence for the
 * four machine steps, a registered device for the link. Nothing depends on a
 * browser checkbox, so no step is unreachable by one student working alone.
 */

/** Dismissal is per team + login so a shared computer doesn't leak it. */
function dismissKey(teamId: string, login: string): string {
  return `cog-setup-dismissed:${teamId}:${login}`;
}

/** The old guide's self-check key. Nothing writes it now; reset still clears
 *  it so a student who used the checkbox guide isn't left with a dead entry. */
function legacyChecksKey(teamId: string, login: string): string {
  return `cog-setup:${teamId}:${login}`;
}

export function clearSetupProgress(teamId: string, login: string): void {
  try {
    localStorage.removeItem(legacyChecksKey(teamId, login));
    localStorage.removeItem(dismissKey(teamId, login));
  } catch {
    /* private mode — there may be nothing durable to clear */
  }
}

export function isSetupDismissed(teamId: string, login: string): boolean {
  try {
    return localStorage.getItem(dismissKey(teamId, login)) === "1";
  } catch {
    return false;
  }
}

export function dismissSetup(teamId: string, login: string): void {
  try {
    localStorage.setItem(dismissKey(teamId, login), "1");
  } catch {
    /* ignore */
  }
}

/** The machine steps the guide's sheet actually shows. SETUP_STEPS also
 *  carries test/run, which are later learning milestones. A poll waiting on
 *  those never stops on a page whose sheet is complete. */
export const CHECKLIST_MACHINE_STEPS = ["clone", "environment", "project", "wiring"] as const;

/**
 * Which command a line is, so a page can attach an explanation to it without
 * holding a second copy of the command or matching on its text.
 */
export type SetupCommandId = "clone" | "tool" | "benchmark" | "link" | "check";

export interface SetupCommand {
  id: SetupCommandId;
  command: string;
  /** True once CogPortal has observed what this command does. */
  verified: boolean;
  /** Whether its evidence is about this benchmark rather than the machine.
   *  Derived from the step it carries, so nothing keeps a second list of
   *  which commands are per-track. */
  benchmarkScoped: boolean;
  /** Which request would have to fail for this line's state to be unknown.
   *  The link line is the only one that reads the device list, so a failed
   *  connections request must not blank the four the setup state answered. */
  evidenceSource: "setup-state" | "devices";
}

/**
 * The commands, in run order, for one team's repository and one track.
 *
 * A student pastes these literally, so the pins, the flag on `check`, and the
 * entry-point names are the product; they are assertable without mounting a
 * route.
 */
export function setupCommandLines(input: {
  cloneUrl: string;
  repoName: string;
  benchmarkId: string;
  benchmarkTitle: string;
  portalOrigin: string;
  verified: (step: SetupStep) => boolean;
  deviceLinked: boolean;
}): SetupCommand[] {
  const pkg = benchmarkPackage(input.benchmarkId);
  const lines: SetupCommand[] = [
    {
      id: "clone",
      command: `git clone ${input.cloneUrl} && cd ${input.repoName}`,
      verified: input.verified("clone"),
      benchmarkScoped: isBenchmarkScopedStep("clone"),
      evidenceSource: "setup-state",
    },
    {
      id: "tool",
      // `--force-reinstall`, not just `--upgrade`. The version stays 0.2.0
      // across pins, and pip treats an equal version as already satisfied:
      // measured, `--upgrade` from one commit to another exited zero and left
      // the installed `direct_url.json` naming the old commit. This package
      // declares no dependencies, so forcing it reinstalls nothing else.
      command: `python -m pip install --upgrade --force-reinstall "cogworks-benchmark @ ${COGBENCH_SOURCE}"`,
      verified: input.verified("environment"),
      benchmarkScoped: isBenchmarkScopedStep("environment"),
      evidenceSource: "setup-state",
    },
  ];

  if (pkg) {
    lines.push({
      // Carries the `project` evidence, though what it installs is the
      // benchmark rather than the student's own code. There used to be a
      // `pip install -e .` line under it registering adapter entry points; no
      // 2026 repository carries a pyproject.toml or setup.py, so that command
      // failed for everyone who ran it, and the resolver reads the repository
      // directly instead.
      id: "benchmark",
      command: `python -m pip install "${pkg.distribution} @ ${pkg.source}"`,
      verified: input.verified("project"),
      benchmarkScoped: isBenchmarkScopedStep("project"),
      evidenceSource: "setup-state",
    });
  }

  lines.push(
    {
      id: "link",
      command: `cogworks link --portal ${input.portalOrigin}`,
      verified: input.deviceLinked,
      benchmarkScoped: false,
      evidenceSource: "devices",
    },
    {
      // --update-setup is what sends the evidence; cli.py returns without a
      // request when the flag is absent, so dropping it would make the comment
      // above false and leave the sheet grey forever.
      id: "check",
      command: `cogworks check --benchmark ${input.benchmarkId} --update-setup`,
      verified: input.verified("wiring"),
      benchmarkScoped: isBenchmarkScopedStep("wiring"),
      evidenceSource: "setup-state",
    },
  );

  return lines;
}

/**
 * The same array from what a page already has in hand.
 *
 * The setup page and the nudge both hold a team, a track and the two setup
 * queries; assembling the verified set here is what keeps their two counts
 * from drifting apart again.
 */
export function setupCommandsForTeam(input: {
  repo: { url: string; name: string };
  benchmark: Benchmark | undefined;
  benchmarkId: string;
  /** Steps CogPortal holds CLI evidence for that are not about a benchmark;
   *  undefined while loading. */
  verifiedSteps: readonly SetupStep[] | undefined;
  /** Steps CogPortal holds evidence for against this track's benchmark. The
   *  install and wiring lines read this and nothing else, so evidence from a
   *  benchmark the student did install cannot tick a box for one they did
   *  not. Undefined while loading, and empty for a track never checked. */
  verifiedStepsForBenchmark?: readonly SetupStep[] | undefined;
  cliDeviceCount: number;
  portalOrigin: string;
}): SetupCommand[] {
  const machine = new Set<SetupStep>(input.verifiedSteps ?? []);
  const thisBenchmark = new Set<SetupStep>(input.verifiedStepsForBenchmark ?? []);

  return setupCommandLines({
    cloneUrl: `${input.repo.url}.git`,
    repoName: input.repo.name,
    benchmarkId: input.benchmarkId,
    benchmarkTitle: input.benchmark?.title ?? input.benchmarkId,
    portalOrigin: input.portalOrigin,
    verified: (step) =>
      isBenchmarkScopedStep(step) ? thisBenchmark.has(step) : machine.has(step),
    deviceLinked: input.cliDeviceCount > 0,
  });
}

export function setupCommandProgress(
  lines: readonly SetupCommand[],
): { verified: number; total: number } {
  return {
    verified: lines.filter((line) => line.verified).length,
    total: lines.length,
  };
}
