"""Materialize a private Week 2 official bundle into the hidden volume.

Writes ``payload.zip`` (sandbox inputs) and ``expected.json`` (controller-only
truth) through ``cogworks_runner.official_bundle``, which never replaces an
existing dataset version: the same manifest again changes nothing, and a
different one needs a new ``--dataset-version``.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from cogworks_runner.official_bundle import (
    UNCHANGED,
    BundleRefused,
    publish_bundle,
    require_usable_destination,
)
from cogworks_runner.week2_payload import encode_cases, recognition_gold
from facial_recognition_benchmark.datasets import (
    assert_disjoint,
    clustering_scenarios,
    load_manifest,
    materialize_manifest,
    recognition_scenarios,
    validate_manifest,
)

DATASET_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
#: Both tracks. A recognition bundle from before expected.json existed is
#: refused as incomplete rather than silently completed under its old name.
BUNDLE_FILES = ("payload.zip", "expected.json")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Materialize a private, validated Week 2 official bundle."
    )
    parser.add_argument("track", choices=("vision-recognition", "vision-clustering"))
    parser.add_argument("manifest", type=Path)
    parser.add_argument("volume_root", type=Path)
    parser.add_argument("--dataset-version", required=True)
    args = parser.parse_args()
    if not DATASET_VERSION.fullmatch(args.dataset_version):
        raise SystemExit(
            "Dataset version must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens."
        )

    target = args.volume_root.resolve() / args.track / args.dataset_version
    try:
        require_usable_destination(target, BUNDLE_FILES)
    except BundleRefused as error:
        raise SystemExit(str(error)) from None

    official = json.loads(args.manifest.read_text(encoding="utf-8"))
    validate_manifest(official)
    assert_disjoint([load_manifest("test"), load_manifest("evaluation"), official])
    materialize_manifest(official)
    if args.track == "vision-recognition":
        cases = recognition_scenarios(official)
        count = sum(
            sum(len(identity.enrollment) + len(identity.queries) for identity in case.known)
            + len(case.unknown_queries)
            + len(case.unknown_enrollment)
            + len(case.post_enrollment_queries)
            for case in cases
        )
        if not 120 <= count <= 180:
            raise SystemExit("Official recognition manifest is outside the reviewed size bound.")
        # Recognition has an expected.json now, same as clustering. It holds
        # the query grouping the payload no longer carries: which query photos
        # belong to which enrolled person, and which belong to the stranger
        # before and after that stranger is enrolled. Without this file the
        # controller cannot score the track, and with it inside payload.zip the
        # sandbox could score itself.
        expected = None
    else:
        cases = clustering_scenarios(official)
        # Stability repeats reuse the base images for findings, not extra scores.
        scored = [case for case in cases if case.scored]
        count = sum(len(case.images) for case in scored)
        if len(scored) != 3 or not 80 <= count <= 120:
            raise SystemExit(
                "Official clustering manifest must contain three scored base cases "
                "with 80 to 120 total images, excluding stability repetitions."
            )
        expected = [list(case.expected_labels) for case in cases]

    # No key: this permutation is a carrier, not a secret. It is undone by
    # `attach_recognition_gold` and the controller reshuffles each run with its
    # own keyed seed, so an operator's machine does not need
    # RUNNER_SIGNING_SECRET. Re-materializing the same manifest deals the same
    # plan and writes the same archive members; the archive's bytes still
    # differ, because zipfile stamps each entry with the clock, which is why
    # `publish_bundle` compares members rather than archive bytes.
    payload, plans = encode_cases(args.track, cases, seed_key=None)
    if args.track == "vision-recognition":
        expected = recognition_gold(plans)
    files = {
        "payload.zip": payload,
        "expected.json": json.dumps(expected, separators=(",", ":")).encode("utf-8"),
    }
    try:
        outcome = publish_bundle(target, files)
    except BundleRefused as error:
        raise SystemExit(str(error)) from None
    if outcome == UNCHANGED:
        print(
            "{} already holds this exact bundle; nothing was written.".format(
                args.dataset_version
            )
        )
        return
    if args.track == "vision-clustering":
        print(
            "Materialized {} scored clustering cases with {} images and {} stability repetitions.".format(
                len(scored), count, len(cases) - len(scored)
            )
        )
    else:
        print("Materialized {} official images for {}.".format(count, args.track))


if __name__ == "__main__":
    main()
