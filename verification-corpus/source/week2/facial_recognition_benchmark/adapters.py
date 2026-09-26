"""Translate student application APIs into the benchmark contracts.

The native protocols are intentionally small.  Reynaldo's broader
``FaceRecognitionApp`` remains supported through an exact compatibility layer
so the reference application can run without adopting benchmark-specific
methods.
"""

from __future__ import annotations

import inspect
import tempfile
import weakref
from pathlib import Path
from typing import Any, List, Optional, Sequence

import numpy as np
from PIL import Image as PillowImage

from .contracts import ClusterId, Image, PersonId


class AdapterContractError(RuntimeError):
    """Report an application-to-benchmark mapping or output error."""


def instantiate(factory: Any, model: Any) -> Any:
    """Create one fresh application or adapter for a benchmark scenario.

    Parameters
    ----------
    factory
        Submission entry-point factory accepting the benchmark-owned FaceNet
        model. Calling it for every scenario keeps application state isolated.
    model
        FaceNet model shared by all submissions in the evaluation lane.

    Returns
    -------
    Any
        The object returned by the submission factory.

    Raises
    ------
    AdapterContractError
        If the entry point is neither an adapter nor a compatible factory.
    """

    if not callable(factory):
        raise _mapping_error(factory, "Entry point is not a callable factory.")
    try:
        inspect.signature(factory).bind(model)
    except TypeError as error:
        raise AdapterContractError(
            "Submission factory must accept the benchmark-owned FaceNet model as its only "
            "required argument."
        ) from error
    return factory(model)


def adapt_recognition(candidate: Any) -> Any:
    """Return a native recognition adapter for an application object.

    Native ``enroll``/``recognize`` objects pass through unchanged. Reynaldo's
    complete documented method surface is adapted from RGB arrays to its
    path-based inputs. Other designs must provide an explicit adapter.

    Parameters
    ----------
    candidate
        Application or adapter created by the submission factory.

    Returns
    -------
    Any
        An object implementing the recognition protocol.
    """

    if callable(getattr(candidate, "enroll", None)) and callable(
        getattr(candidate, "recognize", None)
    ):
        return candidate
    if _has_reynaldo_surface(candidate):
        return _ReynaldoRecognitionAdapter(candidate)
    raise _mapping_error(
        candidate,
        "Recognition requires enroll(person_id, images) and recognize(images), or Reynaldo's "
        "documented add_image_to_database/process_image surface.",
    )


def adapt_clustering(candidate: Any) -> Any:
    """Return a native clustering adapter for an application object.

    Parameters
    ----------
    candidate
        Application or adapter created by the submission factory.

    Returns
    -------
    Any
        An object implementing ``cluster(images, seed=...)``.
    """

    if callable(getattr(candidate, "cluster", None)):
        return candidate
    if _has_reynaldo_surface(candidate):
        return _ReynaldoClusteringAdapter(candidate)
    raise _mapping_error(
        candidate,
        "Clustering requires cluster(images, seed=...), or Reynaldo's documented "
        "cluster_images surface.",
    )


def _has_reynaldo_surface(value: Any) -> bool:
    documented_methods = (
        "detect",
        "compute_descriptors",
        "process_image",
        "recognize_face",
        "add_image_to_database",
        "add_descriptors_to_database",
        "cluster_images",
        "save_database",
        "load_database",
        "get_database_dict",
    )
    return all(callable(getattr(value, name, None)) for name in documented_methods)


def _mapping_error(candidate: Any, detail: str) -> AdapterContractError:
    names = sorted(
        name
        for name, member in inspect.getmembers(candidate)
        if not name.startswith("_") and callable(member)
    )
    available = ", ".join(names) if names else "none"
    return AdapterContractError(
        f"{detail} Public callables found: {available}. Map your application explicitly in "
        "benchmark_adapter.py."
    )


class _ImageFiles:
    def __init__(self) -> None:
        self._directory = tempfile.TemporaryDirectory(prefix="cogworks-week2-")
        self._next_id = 0

    def close(self) -> None:
        self._directory.cleanup()

    def write(self, image: Image) -> str:
        value = _rgb_image(image)
        path = Path(self._directory.name) / f"image-{self._next_id:04d}.png"
        self._next_id += 1
        PillowImage.fromarray(value).save(str(path), format="PNG")
        return str(path)


class _ReynaldoRecognitionAdapter:
    def __init__(self, app: Any) -> None:
        self._app = app
        self._files = _ImageFiles()
        self._cleanup = weakref.finalize(self, self._files.close)

    def enroll(self, person_id: PersonId, images: Sequence[Image]) -> None:
        for image in images:
            if not self._app.add_image_to_database(self._files.write(image), person_id):
                raise AdapterContractError(
                    f"Reynaldo-compatible app could not enroll an image for {person_id!r}."
                )

    def recognize(self, images: Sequence[Image]) -> List[Optional[PersonId]]:
        labels: List[Optional[PersonId]] = []
        for image in images:
            result = self._app.process_image(self._files.write(image))
            faces = result.get("faces") if isinstance(result, dict) else None
            if not faces:
                labels.append(None)
                continue
            name = faces[0].get("name") if isinstance(faces[0], dict) else None
            labels.append(None if name in (None, "Unknown", "unknown") else str(name))
        return labels


class _ReynaldoClusteringAdapter:
    def __init__(self, app: Any) -> None:
        self._app = app

    def cluster(self, images: Sequence[Image], *, seed: int) -> Sequence[ClusterId]:
        state = np.random.get_state()
        np.random.seed(seed)
        try:
            result = self._app.cluster_images(list(images))
        finally:
            np.random.set_state(state)
        if isinstance(result, dict):
            result = result.get("labels")
        if result is None:
            raise AdapterContractError("Reynaldo-compatible cluster_images returned no labels.")
        return list(result)


def _rgb_image(image: Image) -> np.ndarray:
    value = np.asarray(image)
    if value.dtype != np.uint8 or value.ndim != 3 or value.shape[2] != 3:
        raise AdapterContractError("Images must be uint8 RGB arrays with shape (H, W, 3).")
    return value
