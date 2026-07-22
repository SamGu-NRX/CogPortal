from __future__ import annotations

import io
import json
import zipfile
from dataclasses import replace
from typing import Any, Dict, List, Sequence, Tuple

import numpy as np


def encode_cases(benchmark_id: str, cases: Sequence[Any]) -> bytes:
    """Encode only sandbox inputs; expected clustering labels are excluded."""

    images: List[np.ndarray] = []

    def add(values: Sequence[np.ndarray]) -> List[int]:
        indexes = list(range(len(images), len(images) + len(values)))
        images.extend(np.asarray(value, dtype=np.uint8) for value in values)
        return indexes

    records: List[Dict[str, Any]] = []
    if benchmark_id == "vision-recognition":
        for case in cases:
            records.append(
                {
                    "known": [
                        {
                            "person_id": identity.person_id,
                            "enrollment": add(identity.enrollment),
                            "queries": add(identity.queries),
                        }
                        for identity in case.known
                    ],
                    "unknown_person_id": case.unknown_person_id,
                    "unknown_queries": add(case.unknown_queries),
                    "unknown_enrollment": add(case.unknown_enrollment),
                    "post_enrollment_queries": add(case.post_enrollment_queries),
                }
            )
    elif benchmark_id == "vision-clustering":
        for case in cases:
            records.append({"images": add(case.images), "seed": int(case.seed)})
    else:
        raise ValueError("Unsupported Week 2 benchmark.")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr(
            "metadata.json",
            json.dumps({"benchmark_id": benchmark_id, "cases": records}),
        )
        for index, image in enumerate(images):
            value = io.BytesIO()
            np.save(value, image, allow_pickle=False)
            archive.writestr("images/{:04d}.npy".format(index), value.getvalue())
    return buffer.getvalue()


def decode_cases(payload: bytes) -> Tuple[str, List[Any]]:
    from facial_recognition_benchmark.drivers import (
        ClusteringScenario,
        RecognitionIdentity,
        RecognitionScenario,
    )

    with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
        metadata = json.loads(archive.read("metadata.json"))
        image_names = sorted(
            name for name in archive.namelist() if name.startswith("images/")
        )
        images = [
            np.load(io.BytesIO(archive.read(name)), allow_pickle=False)
            for name in image_names
        ]
    benchmark_id = str(metadata["benchmark_id"])

    def select(indexes: Sequence[int]) -> List[np.ndarray]:
        return [images[int(index)] for index in indexes]

    if benchmark_id == "vision-recognition":
        cases = [
            RecognitionScenario(
                known=[
                    RecognitionIdentity(
                        person_id=str(identity["person_id"]),
                        enrollment=select(identity["enrollment"]),
                        queries=select(identity["queries"]),
                    )
                    for identity in record["known"]
                ],
                unknown_person_id=str(record["unknown_person_id"]),
                unknown_queries=select(record["unknown_queries"]),
                unknown_enrollment=select(record["unknown_enrollment"]),
                post_enrollment_queries=select(record["post_enrollment_queries"]),
            )
            for record in metadata["cases"]
        ]
    elif benchmark_id == "vision-clustering":
        cases = [
            ClusteringScenario(
                images=select(record["images"]),
                expected_labels=[],
                seed=int(record["seed"]),
            )
            for record in metadata["cases"]
        ]
    else:
        raise ValueError("Unsupported Week 2 benchmark payload.")
    return benchmark_id, cases


def attach_clustering_labels(cases: Sequence[Any], labels: Sequence[Sequence[Any]]) -> List[Any]:
    if len(cases) != len(labels):
        raise ValueError("Official clustering labels do not match the case count.")
    return [
        replace(case, expected_labels=list(expected))
        for case, expected in zip(cases, labels)
    ]
