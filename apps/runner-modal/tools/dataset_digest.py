"""Print the dataset digest of a published official bundle, for catalog approval.

    modal volume get cogworks-hidden-datasets \\
        language-search/language-search-official-v1 /secure/check
    python apps/runner-modal/tools/dataset_digest.py \\
        --benchmark language-search \\
        --dataset-version language-search-official-v1 \\
        /secure/check/language-search-official-v1

Official runs refuse to score until `benchmarks.dataset_digest` holds the digest
of the exact bytes on the volume (migration 0046). Hash the copy downloaded from
the volume rather than a fresh materialization: zip archives carry timestamps,
so rebuilding the same manifest gives different bytes and a different digest.

Prints the digest and an UPDATE for a reviewed registration migration. The
UPDATE only fills an empty approval. Different bytes are a new dataset version,
never a replaced digest. Reads local files only, never the volume or the catalog.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import List, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from cogworks_runner.official_bundle import (  # noqa: E402
    SCORED_FILES,
    DatasetNotApproved,
    dataset_digest,
    read_bundle,
)

#: The materializers' own rule, so the SQL below can quote it safely.
DATASET_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def registration_sql(benchmark_id: str, dataset_version: str, digest: str) -> str:
    return (
        "UPDATE benchmarks SET dataset_digest = '{}'\n"
        " WHERE id = '{}' AND dataset_version = '{}' AND dataset_digest IS NULL;"
    ).format(digest, benchmark_id, dataset_version)


def report(benchmark_id: str, dataset_version: str, bundle: Path) -> List[str]:
    if not DATASET_VERSION.fullmatch(dataset_version):
        raise DatasetNotApproved("{!r} is not a dataset version name.".format(dataset_version))
    if not bundle.is_dir():
        raise DatasetNotApproved("{} is not a directory.".format(bundle))
    files = read_bundle(bundle, benchmark_id)
    digest = dataset_digest(files)
    lines = ["Dataset digest for {} {}: {}".format(benchmark_id, dataset_version, digest)]
    ignored = sorted(
        path.name for path in bundle.iterdir() if path.name not in SCORED_FILES[benchmark_id]
    )
    if ignored:
        # Never scored, so never hashed; named so a surprise is visible.
        lines.append("Not part of the digest: {}.".format(", ".join(ignored)))
    lines += ["", registration_sql(benchmark_id, dataset_version, digest)]
    return lines


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--benchmark", required=True, choices=sorted(SCORED_FILES))
    parser.add_argument("--dataset-version", required=True)
    parser.add_argument("bundle", type=Path, help="local copy of /<benchmark>/<dataset-version>/")
    arguments = parser.parse_args(argv)
    try:
        lines = report(arguments.benchmark, arguments.dataset_version, arguments.bundle)
    except DatasetNotApproved as error:
        print("dataset digest refused: {}".format(error), file=sys.stderr)
        return 1
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
