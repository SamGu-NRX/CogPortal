from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

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
        count = sum(len(case.images) for case in cases)
        if len(cases) != 3 or not 80 <= count <= 120:
            raise SystemExit("Official clustering manifest must contain three bounded cases.")
        expected = [list(case.expected_labels) for case in cases]

    target = args.volume_root.resolve() / args.track / args.dataset_version
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".week2-official-", dir=str(target.parent)))
    try:
        # No key: this permutation is a carrier, not a secret. It is undone
        # by `attach_recognition_gold` and the controller reshuffles each run
        # with its own keyed seed, so an operator's machine does not need
        # RUNNER_SIGNING_SECRET and re-materializing stays byte-stable.
        payload, plans = encode_cases(args.track, cases, seed_key=None)
        if args.track == "vision-recognition":
            expected = recognition_gold(plans)
        (temporary / "payload.zip").write_bytes(payload)
        if expected is not None:
            (temporary / "expected.json").write_text(
                json.dumps(expected, separators=(",", ":")), encoding="utf-8"
            )
        for path in temporary.iterdir():
            path.chmod(0o440)
        if target.exists():
            shutil.rmtree(str(target))
        os.replace(str(temporary), str(target))
    except Exception:
        shutil.rmtree(str(temporary), ignore_errors=True)
        raise
    print("Materialized {} official images for {}.".format(count, args.track))


if __name__ == "__main__":
    main()
