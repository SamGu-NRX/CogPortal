"""Repository-root submission file, the shape a student repository uses.

``cogbench`` looks for ``submission.py`` at the repository root and calls
``create_submission(resources)``. This one delegates to ``reference_shazam``
and selects between five implementations with ``COGWORKS_W1_VARIANT``:

    tuned            course-recommended parameters (default)
    detuned          same code, percentile 30 and fanout 3
    bag_of_hashes    same fingerprints, vote ignores time offsets
    trivial          mean log spectrum, cosine nearest neighbour, no hashes
    sample_rate_bug  tuned, but the database is built at 16 kHz

    COGWORKS_W1_VARIANT=detuned cogbench run audio-identification
"""

from __future__ import annotations

from reference_shazam.variants import ENV_VAR, VARIANTS, create_submission

__all__ = ["ENV_VAR", "VARIANTS", "create_submission"]
