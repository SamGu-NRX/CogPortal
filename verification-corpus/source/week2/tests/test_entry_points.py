"""Distribution-level discovery tests for benchmark and reference plugins."""

from __future__ import annotations

import importlib.metadata as metadata
from typing import Dict


def entry_points(group: str) -> Dict[str, metadata.EntryPoint]:
    """Return one entry-point group on Python 3.8 and newer runtimes."""

    discovered = metadata.entry_points()
    if hasattr(discovered, "select"):
        values = discovered.select(group=group)
    else:
        values = discovered.get(group, ())
    return {point.name: point for point in values}


def test_benchmark_tracks_are_discoverable() -> None:
    """Load both v2 benchmark objects from installed distribution metadata."""

    points = entry_points("cogworks.benchmarks.v2")
    # Containment, not equality. This asserted that Week 2 was the only
    # benchmark installed anywhere, which fails the moment a developer has
    # Week 1 or Week 3 in the same environment -- and the controller image
    # installs all of them by design, so "only ours is present" was never a
    # property worth holding. What matters is that both of ours resolve.
    assert {"vision-recognition", "vision-clustering"} <= set(points)
    assert points["vision-recognition"].load()().benchmark_version == 2
    assert points["vision-clustering"].load()().benchmark_version == 2


def test_reference_application_tracks_are_discoverable() -> None:
    """Load both golden-application factories without constructing FaceNet."""

    points = entry_points("cogworks.submissions.v2")
    # Same reasoning; the Week 1 and Week 3 reference submissions register
    # here too when they are installed.
    assert {"vision-recognition", "vision-clustering"} <= set(points)
    assert callable(points["vision-recognition"].load())
    assert callable(points["vision-clustering"].load())
