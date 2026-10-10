"""Different-answer control: the answer depends on batch concurrency.

This fixture exists to prove the answer-agreement comparison can FAIL. The
supervisor publishes each batch's concurrency as ``RI_BATCH_CONCURRENCY``;
the fixture answers one constant when it is 1 and a different constant
otherwise, so a sequential leg and a concurrent leg of the SAME adapter
with the SAME inputs produce different constant answers — exactly the shape
the old distinct-count comparison mistook for "identical" (one distinct
digest in each leg, so the counts matched while the answers did not). It
leaks nothing: no input mutation, no state growth, no handles, no children,
no flood. Every run's digest is stable within its leg.
"""

from __future__ import annotations

import os

_SEQ_ANSWER = "mode-variant/sequential"
_CONC_ANSWER = "mode-variant/concurrent"


class Adapter:
    def predict(self, inputs):
        concurrency = os.environ.get("RI_BATCH_CONCURRENCY", "1")
        answer = _SEQ_ANSWER if concurrency in ("", "1") else _CONC_ANSWER
        print("mode_variant: concurrency={} answer={}".format(concurrency, answer))
        return [answer for _ in inputs]
