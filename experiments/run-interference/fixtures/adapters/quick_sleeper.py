"""Fast sleeper for the SIGINT batch: long enough to be interruptible.

Each run sleeps a fraction of a second, so a batch of them spans the
injected SIGINT and the interruption lands mid-batch — sometimes mid-run,
sometimes between runs; the record says which. Single-purpose like the slow
sleeper: clean on every other signal.
"""

from __future__ import annotations

import time


class Adapter:
    def predict(self, inputs):
        time.sleep(0.2)
        return [sum(item["xs"]) for item in inputs]
