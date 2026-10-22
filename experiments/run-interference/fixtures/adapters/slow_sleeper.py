"""Sleeper adapter for the timeout batch: predict outlives its wall clock.

Sleeps far past the manifest's per-run timeout so the isolate module has to
stop it, and spawns one ``sleep`` child so the record shows whether a
timed-out run's own children are reached by the process-group kill or left
orphaned. Deliberately clean on every other signal: a single-fault fixture
isolates what the timeout path itself does.
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

#: Holds the spawned child; no reference, no process — the module-level list
#: is what makes the leak real rather than refcount-cleaned.
_GRANDCHILDREN: list = []


class Adapter:
    def predict(self, inputs):
        # Long past any configured timeout; the isolate module's wall clock
        # is what ends this, not the adapter.
        time.sleep(30)
        return [sum(item["xs"]) for item in inputs]
