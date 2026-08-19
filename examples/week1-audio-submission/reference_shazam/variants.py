"""The five reference implementations, and the one factory that selects them.

Four of the five are the same class with a different ``Params``; the fifth
(the trivial baseline) is a different pipeline on purpose, because it is the
floor rather than an ablation. Selection is by the ``COGWORKS_W1_VARIANT``
environment variable so one ``submission.py`` at the repository root can drive
every ablation without five near-identical copies drifting apart.
"""

from __future__ import annotations

import os
from typing import Any, Callable, Dict, List

from .pipeline import BAG_OF_HASHES, DETUNED, SAMPLE_RATE_BUG, TUNED, Fingerprinter
from .trivial import TrivialBaseline

#: Default when the environment says nothing. The tuned pipeline is the one
#: the instrument is supposed to reward, so it is what a bare run measures.
DEFAULT_VARIANT = "tuned"

ENV_VAR = "COGWORKS_W1_VARIANT"


def _top_k(resources: Any) -> int:
    """Return at least the benchmark's top-k, so ranking can be observed.

    The taxonomy needs to see below rank 1 to tell a ranking failure from a
    retrieval failure. Returning exactly ``top_k`` would make every miss look
    like a retrieval failure, which is the readable-diagnostic property the
    benchmark exists to provide.
    """

    return max(int(getattr(resources, "top_k", 5) or 5) * 2, 10)


def make_tuned(resources: Any = None) -> Fingerprinter:
    """Course-recommended parameters: 75th percentile, fanout 15, offset vote."""

    return Fingerprinter(TUNED, top_k=_top_k(resources))


def make_detuned(resources: Any = None) -> Fingerprinter:
    """Same code, percentile 30 and fanout 3.

    A 30th-percentile floor admits peaks from the noise floor, which are not
    the same peaks between an enrollment and a query of the same song, and a
    fanout of 3 gives each anchor few chances to survive one lost neighbour.
    Whether that is enough to separate it from tuned is measured, not assumed;
    see CALIBRATION.md.
    """

    return Fingerprinter(DETUNED, top_k=_top_k(resources))


def make_bag_of_hashes(resources: Any = None) -> Fingerprinter:
    """Tuned fingerprints, tally ignores offsets.

    A documented negative result. The audit measured this moving the primary
    metric by 0.030, because a ``(f1, f2, dt)`` key already carries local
    temporal structure, so discarding the anchor time removes less than the
    ablation's name suggests.
    """

    return Fingerprinter(BAG_OF_HASHES, top_k=_top_k(resources))


def make_trivial(resources: Any = None) -> TrivialBaseline:
    """Mean log spectrum, cosine nearest neighbour. The floor."""

    return TrivialBaseline(resources, top_k=_top_k(resources))


def make_sample_rate_bug(resources: Any = None) -> Fingerprinter:
    """Tuned, but enrolls at 16 kHz and queries at 44.1 kHz.

    Stored times are spectrogram column indices, so a 16 kHz database and a
    44.1 kHz query have disjoint key spaces and the correct song loses almost
    all of its votes without anything raising. Kept as a permanent regression
    test that the benchmark reports this as retrieval failure with the
    hash-space diagnostic rather than as a mysterious low number.
    """

    return Fingerprinter(SAMPLE_RATE_BUG, top_k=_top_k(resources))


VARIANTS: Dict[str, Callable[[Any], Any]] = {
    "tuned": make_tuned,
    "detuned": make_detuned,
    "bag_of_hashes": make_bag_of_hashes,
    "trivial": make_trivial,
    "sample_rate_bug": make_sample_rate_bug,
}


def variant_names() -> List[str]:
    return list(VARIANTS)


def create_submission(resources: Any = None) -> Any:
    """The factory the benchmark calls. Reads ``COGWORKS_W1_VARIANT``."""

    name = os.environ.get(ENV_VAR, DEFAULT_VARIANT).strip().lower()
    builder = VARIANTS.get(name)
    if builder is None:
        raise ValueError(
            "{}={!r} is not one of: {}.".format(ENV_VAR, name, ", ".join(sorted(VARIANTS)))
        )
    return builder(resources)
