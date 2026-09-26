"""Load fixed CelebA manifests into a verified, atomic local cache.

Only rows named by a versioned manifest are fetched.  Source-identity and
decoded-pixel hashes make the public test and evaluation sets repeatable while
allowing the image files themselves to remain outside the repository.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np
from PIL import Image as PillowImage
from platformdirs import user_cache_path

from .drivers import ClusteringScenario, RecognitionIdentity, RecognitionScenario

DATASET_NAME = "flwrlabs/celeba"
DATASET_REVISION = "2d738f56e0e7f925ea36ae7c808ea925264aacec"
CACHE_VERSION = "v1"


class DatasetError(RuntimeError):
    """Report invalid manifests, downloads, or cached image data."""


@dataclass(frozen=True)
class CacheStatus:
    """Describe whether all data for one manifest is locally ready.

    Attributes
    ----------
    manifest_id
        Stable identifier of the checked manifest.
    ready
        Whether every selected image and cache checksum is valid.
    path
        Versioned platform cache directory.
    message
        ``"ready"`` or an actionable explanation of the cache problem.
    """

    manifest_id: str
    ready: bool
    path: Path
    message: str


def load_manifest(tier: str) -> Dict[str, Any]:
    """Load and validate a packaged public manifest.

    Parameters
    ----------
    tier
        ``"test"`` for the small integration set or ``"evaluation"`` for the
        larger public run.

    Returns
    -------
    dict
        Parsed manifest data.
    """

    filename = f"public-{tier}.json"
    try:
        text = (
            resources.files("facial_recognition_benchmark")
            .joinpath("manifests", filename)
            .read_text(encoding="utf-8")
        )
    except (AttributeError, FileNotFoundError):
        with resources.open_text(
            "facial_recognition_benchmark.manifests", filename, encoding="utf-8"
        ) as stream:
            text = stream.read()
    manifest = json.loads(text)
    validate_manifest(manifest)
    return manifest


def validate_manifest(manifest: Mapping[str, Any]) -> None:
    """Validate manifest schema, references, and pinned dataset metadata.

    Parameters
    ----------
    manifest
        Candidate manifest mapping.

    Raises
    ------
    DatasetError
        If required metadata, hashes, samples, or case references are invalid.
    """

    required = {"schema_version", "manifest_id", "dataset", "revision", "split", "samples"}
    missing = sorted(required.difference(manifest))
    if missing:
        raise DatasetError("Manifest is missing fields: {}.".format(", ".join(missing)))
    if manifest["schema_version"] != 1:
        raise DatasetError("Unsupported dataset manifest schema.")
    if manifest["dataset"] != DATASET_NAME or manifest["revision"] != DATASET_REVISION:
        raise DatasetError("Manifest dataset or revision does not match the pinned release.")
    samples = manifest["samples"]
    if not isinstance(samples, list) or not samples:
        raise DatasetError("Manifest samples must be a non-empty list.")
    sample_ids = [sample.get("sample_id") for sample in samples]
    if any(not isinstance(value, str) or not value for value in sample_ids):
        raise DatasetError("Every sample needs an opaque sample_id.")
    if len(sample_ids) != len(set(sample_ids)):
        raise DatasetError("Manifest sample_id values must be unique.")
    for sample in samples:
        for field in ("row_index", "pixel_sha256", "source_identity_sha256", "width", "height"):
            if field not in sample:
                raise DatasetError("Sample {} is missing {}.".format(sample["sample_id"], field))
        if len(sample["pixel_sha256"]) != 64 or len(sample["source_identity_sha256"]) != 64:
            raise DatasetError("Sample hashes must be SHA-256 hex digests.")

    referenced: List[str] = []
    for scenario in manifest.get("recognition_scenarios", []):
        for identity in scenario.get("known", []):
            referenced.extend(identity.get("enrollment", []))
            referenced.extend(identity.get("queries", []))
        unknown = scenario.get("unknown", {})
        referenced.extend(unknown.get("queries", []))
        referenced.extend(unknown.get("enrollment", []))
        referenced.extend(unknown.get("post_enrollment_queries", []))
    for scenario in manifest.get("clustering_scenarios", []):
        referenced.extend(scenario.get("sample_ids", []))
        if len(scenario.get("sample_ids", [])) != len(scenario.get("labels", [])):
            raise DatasetError("Clustering samples and labels must have the same length.")
    unknown_refs = sorted(set(referenced).difference(sample_ids))
    if unknown_refs:
        raise DatasetError("Cases reference unknown samples: {}.".format(", ".join(unknown_refs)))
    unused = sorted(set(sample_ids).difference(referenced))
    if unused:
        raise DatasetError("Manifest includes unused samples: {}.".format(", ".join(unused)))


def assert_disjoint(manifests: Sequence[Mapping[str, Any]]) -> None:
    """Require manifests to use disjoint source rows and identities.

    Parameters
    ----------
    manifests
        Public or official manifests to compare.

    Raises
    ------
    DatasetError
        If any pair shares a dataset row or source identity.
    """

    seen_rows: Dict[Tuple[str, int], str] = {}
    seen_identities: Dict[str, str] = {}
    for manifest in manifests:
        manifest_id = str(manifest["manifest_id"])
        split = str(manifest["split"])
        for sample in manifest["samples"]:
            row = (split, int(sample["row_index"]))
            prior_row = seen_rows.get(row)
            if prior_row is not None:
                raise DatasetError(
                    f"{prior_row} and {manifest_id} share dataset row {split}:{row[1]}."
                )
            seen_rows[row] = manifest_id
            identity = str(sample["source_identity_sha256"])
            prior_identity = seen_identities.get(identity)
            if prior_identity is not None and prior_identity != manifest_id:
                raise DatasetError(f"{prior_identity} and {manifest_id} share a source identity.")
            seen_identities[identity] = manifest_id


def cache_status(manifest: Mapping[str, Any], cache_root: Optional[Path] = None) -> CacheStatus:
    """Inspect a manifest cache without downloading data.

    Parameters
    ----------
    manifest
        Validated dataset manifest.
    cache_root
        Optional cache root used by tests and managed environments.
    """

    path = _cache_directory(manifest, cache_root)
    try:
        _validate_cache(path, manifest)
    except DatasetError as error:
        return CacheStatus(str(manifest["manifest_id"]), False, path, str(error))
    return CacheStatus(str(manifest["manifest_id"]), True, path, "ready")


def materialize_manifest(
    manifest: Mapping[str, Any],
    cache_root: Optional[Path] = None,
    row_provider: Optional[Callable[[str, str, Sequence[int]], Iterable[Tuple[int, Any]]]] = None,
) -> Path:
    """Download and atomically cache every row selected by a manifest.

    Parameters
    ----------
    manifest
        Fixed manifest describing the required CelebA rows.
    cache_root
        Optional cache root override.
    row_provider
        Optional deterministic row source used by offline tests.

    Returns
    -------
    pathlib.Path
        Verified cache directory containing one ``.npy`` file per sample.
    """

    validate_manifest(manifest)
    target = _cache_directory(manifest, cache_root)
    if cache_status(manifest, cache_root).ready:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{target.name}-", dir=str(target.parent)))
    samples = {int(sample["row_index"]): sample for sample in manifest["samples"]}
    provider = row_provider or _huggingface_rows
    written: List[str] = []
    try:
        for row_index, row in provider(
            str(manifest["split"]), str(manifest["revision"]), sorted(samples)
        ):
            sample = samples.get(row_index)
            if sample is None:
                continue
            image = _row_image(row)
            _verify_row(row, image, sample)
            np.save(str(temporary / "{}.npy".format(sample["sample_id"])), image)
            written.append(str(sample["sample_id"]))
        if set(written) != {str(sample["sample_id"]) for sample in manifest["samples"]}:
            raise DatasetError("Dataset did not return every manifest-selected row.")
        metadata = {
            "manifest_id": manifest["manifest_id"],
            "revision": manifest["revision"],
            "sample_ids": sorted(written),
        }
        (temporary / "cache.json").write_text(
            json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        _validate_cache(temporary, manifest)
        if target.exists():
            shutil.rmtree(str(target))
        os.replace(str(temporary), str(target))
        return target
    except Exception:
        shutil.rmtree(str(temporary), ignore_errors=True)
        raise


def recognition_scenarios(
    manifest: Mapping[str, Any], cache_root: Optional[Path] = None
) -> List[RecognitionScenario]:
    """Materialize a manifest's stateful recognition scenarios.

    Parameters
    ----------
    manifest
        Manifest containing recognition case definitions.
    cache_root
        Optional cache root override.
    """

    root = materialize_manifest(manifest, cache_root)
    output: List[RecognitionScenario] = []
    for scenario in manifest.get("recognition_scenarios", []):
        known = [
            RecognitionIdentity(
                person_id=str(identity["person_id"]),
                enrollment=_images(root, identity["enrollment"]),
                queries=_images(root, identity["queries"]),
            )
            for identity in scenario["known"]
        ]
        unknown = scenario["unknown"]
        output.append(
            RecognitionScenario(
                known=known,
                unknown_person_id=str(unknown["person_id"]),
                unknown_queries=_images(root, unknown["queries"]),
                unknown_enrollment=_images(root, unknown["enrollment"]),
                post_enrollment_queries=_images(root, unknown["post_enrollment_queries"]),
            )
        )
    return output


#: Extra seeds every clustering scenario is also run under.
#:
#: Whispers is a randomized algorithm: it visits nodes in a random order and
#: the course says so. One seed measures one draw, and a submission whose
#: answer swings across draws is telling a team something real about their
#: algorithm that a single number hides. The manifest's own seed stays first
#: and is the only one that scores, so adding these moves no published result.
#:
#: Three, not ten: each seed is a full re-clustering of the same images, and
#: the point is to detect a wide spread rather than to estimate its variance
#: precisely.
STABILITY_SEEDS = (20260819, 31337, 8675309)


def clustering_scenarios(
    manifest: Mapping[str, Any],
    cache_root: Optional[Path] = None,
    include_stability: bool = True,
) -> List[ClusteringScenario]:
    """Materialize a manifest's clustering scenarios, plus the seed sweep.

    Each manifest scenario yields its own scored case first, then one repeat
    per entry in ``STABILITY_SEEDS`` over the identical images. Only the
    scored case counts toward the metrics; the repeats are read by
    ``score`` to report how far the answer moves between draws.
    """

    root = materialize_manifest(manifest, cache_root)
    cases: List[ClusteringScenario] = []
    for scenario in manifest.get("clustering_scenarios", []):
        images = _images(root, scenario["sample_ids"])
        labels = list(scenario["labels"])
        # The manifest's own scenario_id ties each repeat to its scored
        # case, so the spread is measured within one scenario rather than
        # across scenarios of different difficulty.
        key = str(scenario["scenario_id"]) if "scenario_id" in scenario else None
        cases.append(
            ClusteringScenario(
                images=images,
                expected_labels=labels,
                seed=int(scenario["seed"]),
                scenario_key=key,
            )
        )
        if not include_stability:
            continue
        for seed in STABILITY_SEEDS:
            if seed == int(scenario["seed"]):
                continue
            cases.append(
                ClusteringScenario(
                    images=images,
                    expected_labels=labels,
                    seed=seed,
                    scored=False,
                    scenario_key=key,
                )
            )
    return cases


def decoded_pixel_sha256(image: np.ndarray) -> str:
    """Hash contiguous decoded RGB bytes for cache verification."""

    return hashlib.sha256(np.ascontiguousarray(image).tobytes()).hexdigest()


def source_identity_sha256(value: Any) -> str:
    """Hash a source identity before it enters public metadata or logs."""

    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def _cache_directory(manifest: Mapping[str, Any], cache_root: Optional[Path]) -> Path:
    root = cache_root or user_cache_path("cogworks", "CogWorks")
    return Path(root) / "week2-vision" / CACHE_VERSION / str(manifest["manifest_id"])


def _validate_cache(path: Path, manifest: Mapping[str, Any]) -> None:
    metadata_path = path / "cache.json"
    if not metadata_path.is_file():
        raise DatasetError("data cache is missing; run the benchmark once while online")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise DatasetError("data cache metadata is corrupt; remove it and retry") from error
    expected_ids = sorted(str(sample["sample_id"]) for sample in manifest["samples"])
    if (
        metadata.get("manifest_id") != manifest["manifest_id"]
        or metadata.get("revision") != manifest["revision"]
        or metadata.get("sample_ids") != expected_ids
    ):
        raise DatasetError("data cache version does not match this benchmark")
    for sample in manifest["samples"]:
        image_path = path / "{}.npy".format(sample["sample_id"])
        if not image_path.is_file():
            raise DatasetError("data cache is incomplete; retry while online")
        try:
            image = np.load(str(image_path), allow_pickle=False)
        except (OSError, ValueError) as error:
            raise DatasetError("cached image data is corrupt; remove it and retry") from error
        if decoded_pixel_sha256(image) != sample["pixel_sha256"]:
            raise DatasetError("cached image checksum failed; remove it and retry")


def _verify_row(row: Any, image: np.ndarray, sample: Mapping[str, Any]) -> None:
    identity = _row_value(row, ("identity", "Identity", "celeb_id"))
    if source_identity_sha256(identity) != sample["source_identity_sha256"]:
        raise DatasetError("Selected dataset row identity does not match the manifest.")
    if image.shape != (int(sample["height"]), int(sample["width"]), 3):
        raise DatasetError("Decoded image dimensions do not match the manifest.")
    if decoded_pixel_sha256(image) != sample["pixel_sha256"]:
        raise DatasetError("Decoded image checksum does not match the manifest.")


def _row_value(row: Any, names: Sequence[str]) -> Any:
    if not isinstance(row, Mapping):
        raise DatasetError("Dataset row has an unsupported shape.")
    for name in names:
        if name in row:
            return row[name]
    raise DatasetError("Dataset row is missing its identity field.")


def _row_image(row: Any) -> np.ndarray:
    value = _row_value(row, ("image", "Image"))
    if isinstance(value, np.ndarray):
        image = value
    elif isinstance(value, PillowImage.Image):
        image = np.asarray(value.convert("RGB"), dtype=np.uint8)
    else:
        image = np.asarray(PillowImage.open(value).convert("RGB"), dtype=np.uint8)
    if image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] != 3:
        raise DatasetError("Dataset image did not decode to uint8 RGB.")
    return image


def _images(root: Path, sample_ids: Sequence[str]) -> List[np.ndarray]:
    return [np.load(str(root / f"{sample_id}.npy"), allow_pickle=False) for sample_id in sample_ids]


def _huggingface_rows(
    split: str, revision: str, row_indices: Sequence[int]
) -> Iterable[Tuple[int, Any]]:
    try:
        from datasets import load_dataset
    except ImportError as error:
        raise DatasetError(
            "Real-data runs require the benchmark data extra: pip install "
            "'cogworks-week2-vision-benchmark[data]'."
        ) from error
    wanted = set(row_indices)
    if not wanted:
        return
    dataset = load_dataset(DATASET_NAME, split=split, revision=revision, streaming=True)
    last = max(wanted)
    for index, row in enumerate(dataset):
        if index in wanted:
            yield index, row
        if index >= last:
            break
