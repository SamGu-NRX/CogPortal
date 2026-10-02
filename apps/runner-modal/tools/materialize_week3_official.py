"""Materialize the private Week 3 official bundle into the hidden volume.

Input is a private manifest produced by the benchmark repo's
``tools/build_public_manifests.py --official OUT.json --seed N`` (the seed
stays private). Output is ``payload.zip`` (gold-free sandbox inputs) plus
``gold.json`` (controller-only truth), published read-only through
``cogworks_runner.official_bundle``: an existing dataset version is never
replaced, so re-running with the same manifest changes nothing and a different
manifest needs a new ``--dataset-version``.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from cogworks_runner.official_bundle import (
    UNCHANGED,
    BundleRefused,
    dataset_digest,
    publish_bundle,
    read_bundle,
    require_usable_destination,
    scored_files,
)
from cogworks_runner.week3_payload import encode_payload, extract_gold
from language_search_benchmark.datasets import (
    assert_disjoint,
    build_resources,
    load_manifest,
    materialize_cases,
)

DATASET_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
BENCHMARK_ID = "language-search"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Materialize the private Week 3 official bundle."
    )
    parser.add_argument("manifest", type=Path)
    parser.add_argument("volume_root", type=Path)
    parser.add_argument("--dataset-version", required=True)
    args = parser.parse_args()
    if not DATASET_VERSION.fullmatch(args.dataset_version):
        raise SystemExit(
            "Dataset version must start with a letter or number and contain "
            "only letters, numbers, dots, underscores, or hyphens."
        )

    target = args.volume_root.resolve() / BENCHMARK_ID / args.dataset_version
    try:
        require_usable_destination(target, scored_files(BENCHMARK_ID))
    except BundleRefused as error:
        raise SystemExit(str(error)) from None

    official = json.loads(args.manifest.read_text(encoding="utf-8"))
    assert_disjoint([load_manifest("test"), load_manifest("evaluation"), official])
    resources = build_resources(download=True, build_kv=False)
    cases = materialize_cases(official, resources)
    queries = len(cases[1].queries)
    pool = cases[1].descriptors.shape[0]
    if not (100 <= queries <= 300 and 400 <= pool <= 1000):
        raise SystemExit(
            "Official manifest is outside the reviewed size bounds "
            "({} queries, {} pool images).".format(queries, pool)
        )

    payload = encode_payload(BENCHMARK_ID, cases, showcase=False)
    gold = extract_gold(cases)

    files = {
        "payload.zip": payload,
        "gold.json": json.dumps(gold, separators=(",", ":")).encode("utf-8"),
    }
    try:
        outcome = publish_bundle(target, files)
    except BundleRefused as error:
        raise SystemExit(str(error)) from None
    # From the bytes on disk, which after a no-op are the earlier archive's.
    digest = dataset_digest(read_bundle(target, BENCHMARK_ID))
    if outcome == UNCHANGED:
        print(
            "{} already holds this exact bundle; nothing was written.".format(
                args.dataset_version
            )
        )
    else:
        print(
            "Materialized official bundle: {} queries over a {}-image pool.".format(
                queries, pool
            )
        )
    print("Dataset digest for {} {}: {}".format(BENCHMARK_ID, args.dataset_version, digest))


if __name__ == "__main__":
    main()
