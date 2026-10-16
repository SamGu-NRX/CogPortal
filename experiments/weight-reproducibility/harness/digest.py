"""Independent digest rechecking.

The store, the loader and the receipt each compute digests as part of their
own bookkeeping. A recheck that called back into any of them would only re-run
the same code path, so the recheck takes raw bytes and a claimed hex digest and
hashes the bytes again with hashlib, the same primitive the production runner
uses, with nothing else consulted.
"""

from __future__ import annotations

import hashlib


def recheck(claimed: str, data: bytes) -> dict:
    recomputed = hashlib.sha256(data).hexdigest()
    return {
        "claimed": claimed,
        "recomputed": recomputed,
        "match": claimed == recomputed,
    }
