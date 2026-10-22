"""A shared helper both fixture adapters import.

This module is the ordinary way one adapter's leftovers reach the next one
in the same process: not through the adapter's own namespace but through a
helper both loaded. The registry is deliberately plain — a dict any adapter
could read or write — because that is what real shared state looks like.
"""

from __future__ import annotations

REGISTRY: dict = {}

#: The key ``clean_reuse`` reads for its prediction correction. Unset, the
#: correction is 0 and every prediction equals the array sum.
PREDICTION_CORRECTION_KEY = "prediction_correction"


def lookup(key: str, default: int = 0) -> int:
    value = REGISTRY.get(key, default)
    return value if isinstance(value, int) else default


def note(key: str, value: int) -> None:
    REGISTRY[key] = value
