"""Apply a claimed repair to a copy of a variant project, then rerun the
benchmark and compare against the control outcome.

Pairing invariant: round 1 applies the diagnosis RECORDED from the pristine
measurement (the same measured input that produced the stored
diagnoses.json entry) -- the oracle never re-derives it from its own run.
Every post-repair measurement is retained as a raw capture file, and each
later round diagnoses from the immediately preceding retained capture, so
every recorded claim is checkable against the run that produced it.

The oracle never sees the defect/repair key: restoration is judged purely by
whether the repaired variant's measured outcome equals the control's.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from measure import bundle_text, measure_variant, outcome_of, outcomes_match

CONTROL_FILE = "submission.py"


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def apply_repair_ops(source: str, claimed_repair: dict) -> tuple:
    """Apply one claimed repair op. Returns (new_source, applied_description).

    An op the surrogate cannot ground (non_actionable) applies nothing.
    """
    op = claimed_repair.get("op")
    if op == "non_actionable":
        return source, "non_actionable: " + str(claimed_repair.get("reason"))
    if op == "insert_import":
        line = claimed_repair.get("line")
        if not line:
            return source, "non_actionable: no import line known"
        anchor = "from __future__ import annotations"
        if anchor not in source:
            return source, "failed: no anchor for import"
        return source.replace(anchor, anchor + "\n" + line, 1), f"inserted {line!r}"
    if op == "replace":
        find, replace = claimed_repair["find"], claimed_repair["replace"]
        if find not in source:
            return source, f"failed: find-string absent: {find[:60]!r}"
        return source.replace(find, replace, 1), f"replaced {find[:40]!r}"
    return source, f"failed: unknown op {op}"


def oracle(
    variant_dir: Path,
    control_outcome: dict,
    scratch_root: Path,
    *,
    recorded_diagnosis: dict | None = None,
    capture_dir: Path | None = None,
    pristine_capture: str | None = None,
    max_rounds: int = 3,
    with_run: bool = False,
) -> dict:
    """Diagnose -> repair -> rerun loop. Restores = outcome equals control's.

    Round 1 acts on `recorded_diagnosis`, produced by the pristine
    measurement of this variant (same measured input). Each later round
    diagnoses from the retained post-repair capture of the previous round.
    Every post-repair bundle is written under `capture_dir` when given.
    """
    scratch_root.mkdir(parents=True, exist_ok=True)
    work = scratch_root / variant_dir.name
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(variant_dir, work)

    source = (work / CONTROL_FILE).read_text(encoding="utf-8")
    rounds = []
    post_bundle = None
    post_name = None
    round_index = 1
    # import here to avoid a module-level cycle: diagnose is key-blind and
    # this loop is the only place it meets an applied repair.
    from diagnose import diagnose  # noqa: PLC0415

    while round_index <= max_rounds:
        if round_index == 1 and recorded_diagnosis is not None:
            diagnosis = recorded_diagnosis
            diagnosis_source = pristine_capture or "recorded_pristine_measurement"
        else:
            if post_bundle is None:
                pre_bundle = measure_variant(work, with_run=with_run)
                pre_name = "round-1.pre.json"
                if capture_dir is not None:
                    _write_json(capture_dir / pre_name, pre_bundle)
            else:
                pre_bundle = post_bundle
                pre_name = post_name
            diagnosis = diagnose(bundle_text(pre_bundle))
            diagnosis_source = pre_name
        current_text, applied = apply_repair_ops(source, diagnosis["claimed_repair"])
        rounds.append(
            {
                "round": round_index,
                "diagnosis_source": diagnosis_source,
                "diagnosis": diagnosis,
                "applied": applied,
            }
        )
        if current_text == source:
            # Nothing changed; further rounds cannot either.
            break
        (work / CONTROL_FILE).write_text(current_text, encoding="utf-8")
        source = current_text
        post_bundle = measure_variant(work, with_run=with_run)
        post_name = f"round-{round_index}.post.json"
        if capture_dir is not None:
            _write_json(capture_dir / post_name, post_bundle)
        rounds[-1]["post_capture"] = post_name
        rounds[-1]["outcome_matches_control"] = outcomes_match(
            outcome_of(post_bundle), control_outcome
        )
        if rounds[-1]["outcome_matches_control"]:
            break
        round_index += 1

    if post_bundle is not None:
        final_bundle = post_bundle
    else:
        final_bundle = measure_variant(work, with_run=with_run)
        if capture_dir is not None:
            _write_json(capture_dir / "round-0.post.json", final_bundle)
    final_outcome = outcome_of(final_bundle)
    restored = outcomes_match(final_outcome, control_outcome)
    return {
        "variant": variant_dir.name,
        "restored": restored,
        "rounds": rounds,
        "final_outcome": final_outcome,
        "control_outcome": control_outcome,
        "final_capture": post_name or "round-0.post.json",
    }
