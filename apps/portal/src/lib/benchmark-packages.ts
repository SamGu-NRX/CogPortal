/**
 * Which benchmark distribution a track installs, and where pip resolves it.
 *
 * The revisions are the submodule commits recorded in `.gitmodules`; they move
 * when the submodules move. A student's install matches the graded run only
 * while the two agree, so a submodule bump is also an edit here.
 *
 * Each source is a PEP 508 direct reference pinned to a commit rather than a
 * branch: `@main` would silently change what a student installed between two
 * runs of the same command.
 */
export interface BenchmarkPackage {
  /** Distribution name pip installs under. */
  distribution: string;
  /** `git+https://…@<commit>` direct reference. */
  source: string;
}

/**
 * Where pip gets the CogWorks CLI itself: one commit, so two students on this
 * page install the same tool whenever they read it. Move it deliberately when
 * a reviewed CLI lands. The install line forces the reinstall because the
 * version does not change between pins.
 */
export const COGBENCH_SOURCE =
  "git+https://github.com/SamGu-NRX/CogPortal.git@8e09a07c6e0cce75c70845d4566fd756f390c83b#subdirectory=python/cogbench";

const WEEK1_AUDIO: BenchmarkPackage = {
  distribution: "cogworks-week1-audio-benchmark",
  source:
    "git+https://github.com/SamGu-NRX/cogworks-week1-audio-benchmark.git@b590638a4c6d7b0e840723f5d4d38b1a90070a62",
};

// Recognition and clustering are two tracks out of one distribution, so a
// student switching between them installs nothing new.
const WEEK2_VISION: BenchmarkPackage = {
  distribution: "cogworks-week2-vision-benchmark",
  source:
    "git+https://github.com/iReynaldo/ComputerVisionBenchmark.git@c177cf23cdd4f8dbe55401a2eb4bada4c64d37c2",
};

const WEEK3_LANGUAGE: BenchmarkPackage = {
  distribution: "cogworks-week3-language-benchmark",
  source:
    "git+https://github.com/SamGu-NRX/cogworks-week3-language-benchmark.git@b166f5c15e950baccc3785839cdcc660ffe01bb4",
};

export const BENCHMARK_PACKAGES: Readonly<Record<string, BenchmarkPackage>> = {
  "audio-identification": WEEK1_AUDIO,
  "vision-recognition": WEEK2_VISION,
  "vision-clustering": WEEK2_VISION,
  "language-search": WEEK3_LANGUAGE,
};

/** Undefined for a track with no published benchmark distribution yet; the
 *  setup sheet then shows no install line rather than a guessed one. */
export function benchmarkPackage(benchmarkId: string): BenchmarkPackage | undefined {
  return BENCHMARK_PACKAGES[benchmarkId];
}

/**
 * The course environment a track's week expects, from CogWeb's own prerequisite
 * pages rather than from anything the portal decides.
 *
 * Every command below the clone runs inside this environment, so a student who
 * skips it meets `cogworks: command not found` with nothing on the page
 * connecting the two. The names and the pages are transcribed in
 * `docs/capstones/environment.md`; the three below answered 200 on 2026-09-10.
 */
export interface CourseEnvironment {
  /** The conda environment CogWeb tells that week to create. */
  condaEnv: string;
  /** That week's prerequisites page, with the full install list. */
  prereqsUrl: string;
}

const WEEK1_ENV: CourseEnvironment = {
  condaEnv: "week1",
  prereqsUrl: "https://rsokl.github.io/CogWeb/Audio/prereqs.html",
};

const WEEK2_ENV: CourseEnvironment = {
  condaEnv: "week2",
  prereqsUrl: "https://rsokl.github.io/CogWeb/Video/prereqs.html",
};

const WEEK3_ENV: CourseEnvironment = {
  condaEnv: "week3",
  prereqsUrl: "https://rsokl.github.io/CogWeb/Language/prereqs.html",
};

/** Keyed exactly like BENCHMARK_PACKAGES, because both are facts about the
 *  same week: the two vision tracks share week 2's environment the same way
 *  they share its distribution. */
export const BENCHMARK_ENVIRONMENTS: Readonly<Record<string, CourseEnvironment>> = {
  "audio-identification": WEEK1_ENV,
  "vision-recognition": WEEK2_ENV,
  "vision-clustering": WEEK2_ENV,
  "language-search": WEEK3_ENV,
};

/** Undefined for a track whose week we have no CogWeb page for. The page then
 *  says to activate the environment for your week without naming one, rather
 *  than guessing a name that would fail at the prompt. */
export function benchmarkEnvironment(benchmarkId: string): CourseEnvironment | undefined {
  return BENCHMARK_ENVIRONMENTS[benchmarkId];
}
