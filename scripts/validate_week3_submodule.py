"""Guard the week3 submodule against the failure modes week2 actually had:
drifting off the reviewed commit, duplicate package shells, committed
egg-info, and plugin metadata that disagrees with the portal catalog."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BENCHMARK = ROOT / "benchmarks" / "week3"
REVIEWED_COMMIT = "5df927765a15ce56657b6e4e0f66274ac367eb70"

PLUGIN_EXPECTATIONS = {
    'benchmark_id = "language-search"': "benchmark id",
    "benchmark_version = 1": "benchmark version",
    'contract_version = "cogworks.submissions.v2"': "contract version",
    'scorer_version = "retrieval-v1"': "scorer version",
    'primary_metric = "overall"': "primary metric",
}

MIGRATION_EXPECTATIONS = (
    "language-search",
    "cogworks.submissions.v2",
    "language-search-official-v1",
    "retrieval-v1",
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

    migration = (
        ROOT / "apps" / "portal" / "migrations" / "0018_week3_language.sql"
    ).read_text(encoding="utf-8")
    for value in MIGRATION_EXPECTATIONS:
        if value not in migration:
            raise SystemExit("Portal catalog migration is missing {!r}.".format(value))


if __name__ == "__main__":
    main()
