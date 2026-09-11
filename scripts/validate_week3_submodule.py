"""Guard the week3 submodule against the failure modes week2 actually had:
drifting off the reviewed commit, duplicate package shells, committed
egg-info, and plugin metadata that disagrees with the portal catalog."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BENCHMARK = ROOT / "benchmarks" / "week3"
# Moved from b166f5c, which built the case grid in three places: the
# benchmark, the sandbox decoder, and the benchmark's own test fixture. The
# fixture is the one that mattered, because it shipped only the search
# rewrites and so agreed with the decoder that did the same. The benchmark
# now owns one `build_cases`, which the sandbox decoder calls instead of
# assembling the grid itself, and declares the three rewritten retrieval
# metrics the scorer already returned. The same range also makes the package
# import without the SDK, which had left that repository's own CI red.
#
# No version in PLUGIN_EXPECTATIONS moves: a complete grid scores identically,
# so this is not a scorer bump and needs no migration.
REVIEWED_COMMIT = "2e94f696d48016283ace59f1ce72339ed1b48d4f"

PLUGIN_EXPECTATIONS = {
    'benchmark_id = "language-search"': "benchmark id",
    "benchmark_version = 1": "benchmark version",
    'contract_version = "cogworks.submissions.v2"': "contract version",
    # Tracks the catalog row, which migration 0032 moved to retrieval-v4 when
    # `search_mrr` changed from the verbatim rung alone to the mean of the
    # four query rewrites. Leaving this at retrieval-v2 would assert the
    # catalog says something it no longer says.
    'scorer_version = "retrieval-v4"': "scorer version",
    'primary_metric = "overall"': "primary metric",
}

# Every superseded version stays listed. The check is that some migration
# mentions each value, so keeping the older ones asserts that the history
# explaining each bump is still in the tree rather than having been squashed
# away; a run scored under an older version is still readable only because
# its migration says what that version measured.
MIGRATION_EXPECTATIONS = (
    "language-search",
    "cogworks.submissions.v2",
    "language-search-official-v1",
    "retrieval-v2",
    "retrieval-v3",
    "week3-cpu-v1",
)


def main() -> None:
    if not (BENCHMARK / ".git").exists():
        raise SystemExit(
            "benchmarks/week3 is missing. Clone with --recurse-submodules or run "
            "git submodule update --init --recursive."
        )
    actual = subprocess.check_output(
        ["git", "-C", str(BENCHMARK), "rev-parse", "HEAD"], text=True
    ).strip()
    if actual != REVIEWED_COMMIT:
        raise SystemExit(
            "benchmarks/week3 is at {}, expected reviewed commit {}.".format(
                actual, REVIEWED_COMMIT
            )
        )

    # Judge tracked files, not the working tree: local editable installs
    # legitimately drop egg-info next to the source.
    tracked = subprocess.check_output(
        ["git", "-C", str(BENCHMARK), "ls-files"], text=True
    ).splitlines()
    if any(path.startswith("src/") for path in tracked):
        raise SystemExit(
            "benchmarks/week3 tracks a src/ shell; the package is top-level only."
        )
    if any(".egg-info" in path for path in tracked):
        raise SystemExit("benchmarks/week3 tracks egg-info metadata; remove it.")
    packages = sorted(
        {
            path.split("/")[0]
            for path in tracked
            if path.endswith("__init__.py") and not path.startswith("tests/")
        }
    )
    if packages != ["language_search_benchmark"]:
        raise SystemExit(
            "benchmarks/week3 must contain exactly the language_search_benchmark "
            "package; found {}.".format(packages)
        )

    plugin_source = (BENCHMARK / "language_search_benchmark" / "plugins.py").read_text(
        encoding="utf-8"
    )
    for needle, label in PLUGIN_EXPECTATIONS.items():
        if needle not in plugin_source:
            raise SystemExit(
                "Plugin {} does not match the reviewed catalog row.".format(label)
            )

    pyproject = (BENCHMARK / "pyproject.toml").read_text(encoding="utf-8")
    if not re.search(
        r'\[project\.entry-points\."cogworks\.benchmarks\.v2"\]\s*\nlanguage-search',
        pyproject,
    ):
        raise SystemExit(
            "pyproject does not register the language-search v2 entry point."
        )

    # Every migration, not only the one that introduced the row. A version
    # bump is a new migration by design, so pinning the original file here
    # would fail the moment the thing this check exists to guard actually
    # happened.
    migrations = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((ROOT / "apps" / "portal" / "migrations").glob("*.sql"))
    )
    for value in MIGRATION_EXPECTATIONS:
        if value not in migrations:
            raise SystemExit("No portal migration mentions {!r}.".format(value))


if __name__ == "__main__":
    main()
