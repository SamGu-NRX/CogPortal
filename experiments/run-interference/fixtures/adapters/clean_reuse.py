"""Clean control adapter: appropriate reuse, nothing more.

Module-level state here is the legitimate kind. A keyed correction table is
filled on first use and idempotent afterwards (``setdefault``), so two runs
in one process see a namespace that initialized once and then held still —
the shape of appropriate reuse. Every resource is scoped to the call: files
open in ``with`` blocks, no children are spawned, and output is a line per
case. Nothing this adapter does should ever be flagged.
"""

from __future__ import annotations

from pathlib import Path

import shared_registry

#: Keyed memo of corrections by case size. Idempotent by construction:
#: ``setdefault`` writes the same value for the same key, so concurrency
#: or repetition cannot make it grow beyond its key set.
_CORRECTIONS: dict = {}


class Adapter:
    def predict(self, inputs):
        answers = []
        for item in inputs:
            _CORRECTIONS.setdefault(item["n"], 0)
            correction = shared_registry.lookup(shared_registry.PREDICTION_CORRECTION_KEY, 0)
            # A scoped handle per case: opened, written, closed before the
            # next case runs. No descriptor outlives the call.
            workspace = Path(item["workspace"])
            with open(workspace / "clean-{}.txt".format(item["n"]), "w", encoding="utf-8") as stream:
                stream.write("summed {}\n".format(item["n"]))
            answers.append(sum(item["xs"]) + correction + _CORRECTIONS[item["n"]])
        print("clean_reuse: {} cases".format(len(inputs)))
        return answers
