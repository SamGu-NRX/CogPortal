"""Contaminated control adapter: leaks every signal the detector watches.

This is the control the detector MUST flag, and every leak in it is a
realistic shape, not an exotic one:

- a module-level list appended per call, so state grows every run (module
  globals, and predictions that drift as a consequence);
- a write into ``shared_registry``, so the NEXT adapter in this process
  inherits changed behavior (the cross-adapter case the study exists for);
- in-place edits to the input payloads (mutated arrays);
- one file opened per run and never closed, the handle kept alive by a
  module-level list so refcounting cannot silently clean it up (unclosed
  handles);
- one ``sleep`` child spawned per run and never waited (leftover children);
- a print loop far past any reasonable output budget (output flooding).

Nothing here is subtle or adversarial: each leak is the ordinary mistake
the real runner's in-process lifecycle lets one run hand to the next.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import shared_registry

#: Grows by one entry per predict call. Never read, never trimmed — the
#: canonical accumulating global.
_CALL_LOG: list = []

#: Holds file objects opened and never closed. The reference here is what
#: keeps them alive; without it CPython's refcounting would close them and
#: the leak would hide itself.
_LEAKED_HANDLES: list = []

#: Holds spawned children that are never waited on.
_ABANDONED_CHILDREN: list = []


class Adapter:
    def predict(self, inputs):
        _CALL_LOG.append(len(inputs))
        # The cross-adapter leak: a clean adapter loaded after this one reads
        # the registry and answers differently without any warning of its own.
        shared_registry.note(shared_registry.PREDICTION_CORRECTION_KEY, 99)

        answers = []
        for item in inputs:
            # In-place mutation of the runner's case inputs.
            item["xs"].append(item["n"])
            item["n"] += 1
            answers.append(sum(item["xs"]) + len(_CALL_LOG))
            # One descriptor per case, deliberately never closed.
            _LEAKED_HANDLES.append(open(Path(item["workspace"]) / "leak-{}.txt".format(item["n"]), "w", encoding="utf-8"))
        # One child per call, deliberately never waited on.
        _ABANDONED_CHILDREN.append(subprocess.Popen(["sleep", "5"]))
        # Flooding: ~30k short lines, far past the capture cap.
        for index in range(30000):
            print("flood line {:06d} padding-padding-padding".format(index))
        return answers
