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
 * `5c8efc6` is the beta commit that pinned Language `9e4dcff`. Its SDK is the
 * one the hosted images bake: #58's resolver fix (replaying a candidate keeps
 * the identities the resolver inferred) on top of #53, with install advice
 * naming the same Language commit as `benchmarks/week3`.
 */
export const COGBENCH_SOURCE =
  "git+https://github.com/SamGu-NRX/CogPortal.git@5c8efc68a0d8e739cc007b5055ee7759ce10dc27#subdirectory=python/cogbench";

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

// f5f7347 builds a team's database before calling an image encoder that is
// one of its methods. The SDK no longer lends a run the object discovery
// built, so 6dc63fe, which called the encoder first, failed CI run 35766833651.
// 9e4dcff (#6) adds a finding that leads a clean run with search against
// retrieval; it changes no metric, dataset, contract or scorer. No staging
// image has run it yet.
// 6dc63fe is the revision verified on staging (run_28df471772), where earlier
// revisions had left a trained image projection unbound locally while a
// hosted run scored it.
const WEEK3_LANGUAGE: BenchmarkPackage = {
  distribution: "cogworks-week3-language-benchmark",
  source:
    "git+https://github.com/SamGu-NRX/cogworks-week3-language-benchmark.git@9e4dcff9a5abe85817f9a208e75aaa392970b649",
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
