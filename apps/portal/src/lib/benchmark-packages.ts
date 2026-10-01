/**
 * Which benchmark distribution a track installs, and where pip resolves it.
 *
 * Pins follow the accepted release's benchmark gitlinks and source repositories.
 * Update these with each accepted benchmark revision so local installation and
 * hosted scoring use the same source.
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
  /** The package's command for public data its `check` reads but pip does
   *  not install, when there is such data. */
  dataCommand?: string;
}

/**
 * Where pip gets the CogWorks CLI itself: one commit, so two students on this
 * page install the same tool whenever they read it. Move it deliberately when
 * a reviewed CLI lands. The install line forces the reinstall because the
 * version does not change between pins.
 *
 * This pin moves with the portal deploy. The setup evidence request is
 * `.strict()`, so a CLI and a portal that disagree about its fields (such as
 * `checkedBenchmarkId`) under-report or refuse each other's evidence.
 *
 * Pin a commit whose CLI install advice names the same benchmark commits as
 * this file, so a student told to install a missing benchmark gets the one
 * this page describes.
 */
export const COGBENCH_SOURCE =
  "git+https://github.com/SamGu-NRX/CogPortal.git@7e135c9b13b57b9d284709f6b65df171af15f6c9#subdirectory=python/cogbench";

const WEEK1_AUDIO: BenchmarkPackage = {
  distribution: "cogworks-week1-audio-benchmark",
  source:
    "git+https://github.com/SamGu-NRX/cogworks-week1-audio-benchmark.git@4e516f39ffbeefe579e093260b2865eb354c17a7",
};

// Recognition and clustering are two tracks out of one distribution, so a
// student switching between them installs nothing new.
const WEEK2_VISION: BenchmarkPackage = {
  distribution: "cogworks-week2-vision-benchmark",
  source:
    "git+https://github.com/SamGu-NRX/cogworks-week2-vision-benchmark.git@a3dd948d0c108fabf070b4f159acdecd4d6c3897",
};

// Language's check reads the course captions before it searches a repository
// and never downloads them, so a fresh machine needs the fetch first.
const WEEK3_LANGUAGE: BenchmarkPackage = {
  distribution: "cogworks-week3-language-benchmark",
  source:
    "git+https://github.com/SamGu-NRX/cogworks-week3-language-benchmark.git@13a164eab8107fdf320ec53b2f39ed095188375e",
  dataCommand: "python -m language_search_benchmark.fetch",
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
