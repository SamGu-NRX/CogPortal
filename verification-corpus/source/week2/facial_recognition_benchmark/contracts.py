"""Structural interfaces shared by the Week 2 benchmark tracks."""

from __future__ import annotations

from typing import Optional, Protocol, Sequence, Union

import numpy as np

Image = np.ndarray
PersonId = str
ClusterId = Union[str, int]


class RecognitionAdapter(Protocol):
    """Behavior required for stateful enrollment and recognition scenarios."""

    def enroll(self, person_id: PersonId, images: Sequence[Image]) -> None: ...

    def recognize(self, images: Sequence[Image]) -> Sequence[Optional[PersonId]]: ...


class ClusteringAdapter(Protocol):
    """Behavior required to partition one-face images by identity."""

    def cluster(self, images: Sequence[Image], *, seed: int) -> Sequence[ClusterId]: ...
