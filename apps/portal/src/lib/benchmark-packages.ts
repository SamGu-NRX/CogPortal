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
 * Where pip gets the CogWorks CLI itself.
 *
 * The branch PR #1 is open from. Becomes @main when it merges; until then main
 * holds cogbench 0.1.0, which has no resolver.
 *
 * This is the one source here pinned to a moving ref rather than a commit, and
 * that is deliberate: the tool reads a student's repository and reports what it
 * found, so it has to move with the branch. The install line keeps `--upgrade`
 * so re-running it picks the branch's current head up.
 */
export const COGBENCH_SOURCE =
  "git+https://github.com/SamGu-NRX/CogPortal.git@fix/product-description-triage#subdirectory=python/cogbench";

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
