from __future__ import annotations

import numpy as np
import pytest

from facial_recognition_benchmark.datasets import (
    DATASET_NAME,
    DATASET_REVISION,
    DatasetError,
    assert_disjoint,
    cache_status,
    decoded_pixel_sha256,
    load_manifest,
    materialize_manifest,
    source_identity_sha256,
    validate_manifest,
)


def minimal_manifest(image):
    return {
        "schema_version": 1,
        "manifest_id": "fixture-v1",
        "dataset": DATASET_NAME,
        "revision": DATASET_REVISION,
        "split": "valid",
        "samples": [
            {
                "sample_id": "opaque_0",
                "row_index": 7,
                "pixel_sha256": decoded_pixel_sha256(image),
                "source_identity_sha256": source_identity_sha256(42),
                "width": 2,
                "height": 2,
            }
        ],
        "recognition_scenarios": [],
        "clustering_scenarios": [
            {"scenario_id": "fixture", "seed": 1, "sample_ids": ["opaque_0"], "labels": [0]}
        ],
    }


def test_public_manifests_are_valid_and_disjoint():
    public_test = load_manifest("test")
    public_evaluation = load_manifest("evaluation")
    validate_manifest(public_test)
    validate_manifest(public_evaluation)
    assert_disjoint([public_test, public_evaluation])
    assert (
        sum(
            len(item["queries"]) + len(item["enrollment"])
            for item in public_test["recognition_scenarios"][0]["known"]
        )
        == 15
    )
    assert len(public_test["clustering_scenarios"][0]["sample_ids"]) == 12
    assert len(public_evaluation["clustering_scenarios"][0]["sample_ids"]) == 32


def test_cache_is_written_atomically_and_reused(tmp_path):
    image = np.ones((2, 2, 3), dtype=np.uint8)
    manifest = minimal_manifest(image)
    calls = []

    def provider(split, revision, indices):
        calls.append((split, revision, indices))
        yield 7, {"image": image, "celeb_id": 42}

    path = materialize_manifest(manifest, tmp_path, provider)
    assert cache_status(manifest, tmp_path).ready
    assert (path / "cache.json").is_file()
    assert materialize_manifest(manifest, tmp_path, provider) == path
    assert len(calls) == 1


def test_bad_pixels_never_create_valid_cache(tmp_path):
    expected = np.ones((2, 2, 3), dtype=np.uint8)
    manifest = minimal_manifest(expected)

    def provider(split, revision, indices):
        yield 7, {"image": np.zeros_like(expected), "celeb_id": 42}

    with pytest.raises(DatasetError, match="checksum"):
        materialize_manifest(manifest, tmp_path, provider)
    assert not cache_status(manifest, tmp_path).ready
