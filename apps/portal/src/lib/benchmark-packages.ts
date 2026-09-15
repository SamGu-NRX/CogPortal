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
    "git+https://github.com/SamGu-NRX/cogworks-week1-audio-benchmark.git@b156644aecc810e0b93535e320098f96c39ae04e",
};

// Recognition and clustering are two tracks out of one distribution, so a
// student switching between them installs nothing new.
const WEEK2_VISION: BenchmarkPackage = {
  distribution: "cogworks-week2-vision-benchmark",
  source:
    "git+https://github.com/SamGu-NRX/cogworks-week2-vision-benchmark.git@b9055031bf25a18594651d89610f3fbcd7462db8",
};

// Matches the verified staging image, which runs 6dc63fe. Earlier revisions
// counted the SDK's retained copy of a trained model as a second candidate for
// the trained image projection and withheld the weight inputs, so a student
// checking locally on one saw their image side unbound while a hosted run
// scored it. Observed on staging run_28df471772; this revision also stops
// repeating the chance baselines as notes and names the metric its chart
// draws, so a local check and a hosted result read the same way.
const WEEK3_LANGUAGE: BenchmarkPackage = {
  distribution: "cogworks-week3-language-benchmark",
  source:
    "git+https://github.com/SamGu-NRX/cogworks-week3-language-benchmark.git@6dc63fe8f6af2b3554a21f7707debb138f31ae4e",
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
