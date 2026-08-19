from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BENCHMARK = ROOT / "benchmarks" / "week2"
REVIEWED_COMMIT = "f0ced7d2f20e222e8b6805ff882420766b253632"


def main() -> None:
    if not (BENCHMARK / ".git").exists():
        raise SystemExit(
            "benchmarks/week2 is missing. Clone with --recurse-submodules or run "
            "git submodule update --init --recursive."
        )
    actual = subprocess.check_output(
        ["git", "-C", str(BENCHMARK), "rev-parse", "HEAD"], text=True
    ).strip()
    if actual != REVIEWED_COMMIT:
        raise SystemExit(
            "benchmarks/week2 is at {}, expected reviewed commit {}.".format(
                actual, REVIEWED_COMMIT
            )
        )
    descriptor = json.loads(
        (BENCHMARK / "facial_recognition_benchmark" / "descriptor.json").read_text(
            encoding="utf-8"
        )
    )
    expected = {
        "vision-recognition": (2, "recognition-v1", "recognition_score"),
        "vision-clustering": (2, "clustering-v2", "clustering_pairwise_f1"),
    }
    for track, values in expected.items():
        record = descriptor["tracks"].get(track)
        actual_values = (
            record.get("benchmark_version"),
            record.get("scorer_version"),
            record.get("primary_metric"),
        ) if record else None
        if actual_values != values:
            raise SystemExit("Descriptor metadata does not match {} v2.".format(track))
    # Every migration, not only the one that introduced the row. A version
    # bump is a new migration by design, so pinning the original file would
    # fail the moment the thing this guards actually happened.
    migration = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((ROOT / "apps" / "portal" / "migrations").glob("*.sql"))
    )
    for value in (
        "cogworks.submissions.v2",
        "celeba-official-v1",
        "recognition-v1",
        "clustering-v2",
    ):
        if value not in migration:
            raise SystemExit("No portal migration mentions {!r}.".format(value))


if __name__ == "__main__":
    main()
