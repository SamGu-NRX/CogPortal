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
}

/**
 * Where pip gets the CogWorks CLI itself: one commit, so two students on this
 * page install the same tool whenever they read it. Move it deliberately when
 * a reviewed CLI lands. The install line forces the reinstall because the
 * version does not change between pins.
 *
 * This pin and the portal deploy are coupled in both directions and have to
 * move together. A CLI that predates `checkedBenchmarkId` leaves a student who
 * ran every command on this page short of complete, with nothing on the page
 * to do about it; and because the evidence request is `.strict()`, a current
 * CLI pointed at a portal that predates the field is refused outright. Nobody
 * reaches that through this page, which serves whichever pin its own deploy
 * carries, but `--portal` at an older deployment does.
 *
 * The retained-input SDK and Week3 pin move together: reports name captured
 * bytes and sync uploads those retained files, rather than rereading changed
 * project weights. The accepted local contract/storage and memo checks cover
 * supported adapters; they do not establish weighted course compatibility.
 * `d9405278` preserves that implementation and repairs its CI fixtures and
 * strict Week3 validator. Final combined live rehearsal remains separate.
 */
export const COGBENCH_SOURCE =
  "git+https://github.com/SamGu-NRX/CogPortal.git@d9405278aac8268cd340e589f36dbad766d1e2a0#subdirectory=python/cogbench";

const WEEK1_AUDIO: BenchmarkPackage = {
  distribution: "cogworks-week1-audio-benchmark",
  source:
    "git+https://github.com/SamGu-NRX/cogworks-week1-audio-benchmark.git@839dd06bc2a14d2b1fa2202f9dc107ff5789c75a",
};

// Recognition and clustering are two tracks out of one distribution, so a
// student switching between them installs nothing new.
const WEEK2_VISION: BenchmarkPackage = {
  distribution: "cogworks-week2-vision-benchmark",
  source:
    "git+https://github.com/SamGu-NRX/cogworks-week2-vision-benchmark.git@43e5a8f917562038748cd392e5ae86720c0e11d7",
};

// f5f7347 builds a team's database before calling an image encoder that is
// one of its methods. The SDK no longer lends a run the object discovery
// built, so 6dc63fe, which called the encoder first, failed CI run 35766833651.
// No staging image has run it or its test follow-up a2fdcfd yet. 6dc63fe is
// the revision verified on staging (run_28df471772), where earlier revisions
// had left a trained image projection unbound locally while a hosted run
// scored it.
const WEEK3_LANGUAGE: BenchmarkPackage = {
  distribution: "cogworks-week3-language-benchmark",
  source:
    "git+https://github.com/SamGu-NRX/cogworks-week3-language-benchmark.git@a2fdcfd02a3aa26e7e7685514eb260d3dd7d4fe0",
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
