"""Derive a diagnosis (cause class + claimed repair) from a diagnostic bundle.

This module is the study's student surrogate. It reads only the words the
instrument printed - measure.bundle_text output - and never the defect/repair
key, the frozen patches, or the grading records. Its rule table was authored
from pre-study probes of the instrument and is part of the measurement
instrument, exactly as a competent reader's expectations are.

A claimed repair is a structured edit the oracle can apply. A diagnosis whose
evidence supports no edit claims `non_actionable` - the honest reading when
the diagnostic's own advice ("check that one code path resamples both") names
no change a repairer could make.
"""
from __future__ import annotations

import re
from typing import Optional

#: Names the surrogate knows how to restore, and the import line each needs.
IMPORT_PROVIDERS = {
    "np": "import numpy as np",
}

RULES = (
    {
        # Observed: "8 songs failed to enroll ... First: song-00: NameError:
        # name 'np' is not defined at submission.py:12"
        "class": "name_error",
        "pattern": re.compile(r"NameError: name '(?P<name>\w+)' is not defined at (?P<file>\S+):(?P<line>\d+)"),
        "repair": lambda m: {
            "op": "insert_import",
            "name": m.group("name"),
            "line": IMPORT_PROVIDERS.get(m.group("name")),
            "file": m.group("file"),
        }
        if m.group("name") in IMPORT_PROVIDERS
        else {"op": "non_actionable", "reason": "no known provider for name"},
    },
    {
        # Observed: "| received MiniSearch with callables: enroll, identify |
        # missing: identify(samples, sample_rate) | identify looks like
        # identify but accepts only 1 positional arguments; not mapped"
        "class": "signature",
        "pattern": re.compile(r"missing: identify\(samples, sample_rate\)"),
        "repair": lambda m: {
            "op": "replace",
            "find": "def identify(self, samples):\n        spec = song_spectrogram(samples)",
            "replace": "def identify(self, samples, sample_rate):\n        spec = song_spectrogram(samples, sample_rate)",
        },
    },
    {
        # Observed: "identify returned ranked ids without scores ... Return
        # (song_id, score) pairs to get this column."
        "class": "shape_pairs",
        "pattern": re.compile(r"returned ranked ids without scores"),
        "guard": lambda text: not re.search(
            r"came back with no shared fingerprints at all|Retrieval, not ranking", text
        ),
        "repair": lambda m: {
            "op": "replace",
            "find": "return [sid for sid, v in ranked[:TOP]]",
            "replace": "return [(sid, float(v)) for sid, v in ranked[:TOP]]",
        },
    },
    {
        # Observed for wrong_order (ascending sort): "86% of queries found no
        # candidate at all. Retrieval, not ranking, is what is failing: the
        # clip's fingerprints are not landing on the same keys the database
        # stored." The claimed cause is the wrong stage; the diagnostic's own
        # advice points at resampling/hash units, not at any edit.
        "class": "hash_space",
        "pattern": re.compile(r"Retrieval, not ranking, is what is failing"),
        "repair": lambda m: {"op": "non_actionable", "reason": "diagnostic names no edit: claims hash-space mismatch"},
    },
    {
        # Observed for empty_result: "Almost every query came back with no
        # shared fingerprints at all, which usually means your database and
        # your queries are in different hash spaces. Check that one code path
        # resamples both..."
        "class": "hash_space",
        "pattern": re.compile(r"in different hash spaces"),
        "repair": lambda m: {"op": "non_actionable", "reason": "diagnostic names no edit: claims hash-space mismatch"},
    },
)


def diagnose(bundle_text_value: str) -> dict:
    """First matching rule wins; evidence records what matched. A rule with a
    guard is skipped when its guard rejects the bundle."""
    for rule in RULES:
        match = rule["pattern"].search(bundle_text_value)
        if not match:
            continue
        guard = rule.get("guard")
        if guard and not guard(bundle_text_value):
            continue
        claimed_repair = rule["repair"](match)
        return {
            "claimed_class": rule["class"],
            "claimed_repair": claimed_repair,
            "evidence": match.group(0)[:200],
        }
    return {
        "claimed_class": "undiagnosed",
        "claimed_repair": {"op": "non_actionable", "reason": "no rule matched the diagnostic bundle"},
        "evidence": None,
    }
