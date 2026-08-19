"""Reference and ablation submissions for the Week 1 audio benchmark.

Staff-only. These exist to calibrate the instrument: to check that a good
pipeline outscores a detuned one, that both outscore a baseline with no
fingerprints at all, and that a known real bug lands in the failure category
that names it. Students never see this package.
"""

from .pipeline import BAG_OF_HASHES, DETUNED, SAMPLE_RATE_BUG, TUNED, Fingerprinter, Params
from .trivial import TrivialBaseline
from .variants import VARIANTS, create_submission, variant_names

__version__ = "0.1.0"

__all__ = [
    "BAG_OF_HASHES",
    "DETUNED",
    "SAMPLE_RATE_BUG",
    "TUNED",
    "Fingerprinter",
    "Params",
    "TrivialBaseline",
    "VARIANTS",
    "create_submission",
    "variant_names",
]
