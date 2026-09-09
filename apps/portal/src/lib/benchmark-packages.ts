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
 * A commit, not a branch. This line used to name
 * `fix/product-description-triage`, which is 22 commits behind the reviewed
 * CLI: installing from it gives a `cogworks check` that shares no readiness
 * decision with `cogworks run`, reads the repository in this process, and
 * picks a week folder by a word every week shares. A student following the
 * setup page would have been demonstrating none of the corrections.
 *
 * A moving ref also makes what a student installed depend on when they ran
 * the command, so two people on the same page get different tools. Move this
 * deliberately when a reviewed CLI lands, the way any other pin moves. The
 * install line keeps `--upgrade` so a student who ran the old one is not left
 * holding it.
 *
 * Reachable on `feat/automatic-discovery`, the branch PR #1 is open from.
 */
export const COGBENCH_SOURCE =
  "git+https://github.com/SamGu-NRX/CogPortal.git@097a74409e0f93ecaa6c4dea58229a965dd502a3#subdirectory=python/cogbench";

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
