"""Apply a claimed repair to a copy of a variant project, then rerun the
benchmark and compare against the control outcome.

The oracle never sees the defect/repair key: restoration is judged purely by
whether the repaired variant's measured outcome equals the control's.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from measure import measure_variant, outcome_of

CONTROL_FILE = "submission.py"


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
    max_rounds: int = 3,
    with_run: bool = False,
) -> dict:
    """Diagnose -> repair -> rerun loop. Restores = outcome equals control's."""
    scratch_root.mkdir(parents=True, exist_ok=True)
    work = scratch_root / variant_dir.name
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(variant_dir, work)

    source = (work / CONTROL_FILE).read_text(encoding="utf-8")
    rounds = []
    # import here to avoid a module-level cycle: diagnose is key-blind and
    # this loop is the only place it meets an applied repair.
    from diagnose import diagnose  # noqa: PLC0415

    for round_index in range(1, max_rounds + 1):
        bundle = measure_variant(work, with_run=with_run)
        outcome = outcome_of(bundle)
        current_text = source
        diagnosis = None
        if outcome != control_outcome:
            from measure import bundle_text  # noqa: PLC0415

            diagnosis = diagnose(bundle_text(bundle))
            current_text, applied = apply_repair_ops(source, diagnosis["claimed_repair"])
            (work / CONTROL_FILE).write_text(current_text, encoding="utf-8")
            rounds.append(
                {
                    "round": round_index,
                    "outcome_matches_control": outcome == control_outcome,
                    "diagnosis": diagnosis,
                    "applied": applied,
                }
            )
            if current_text == source:
                # Nothing changed; further rounds cannot either.
                break
            source = current_text
        else:
            rounds.append({"round": round_index, "outcome_matches_control": True})
            break

    final_bundle = measure_variant(work, with_run=with_run)
    final_outcome = outcome_of(final_bundle)
    restored = final_outcome == control_outcome
    return {
        "variant": variant_dir.name,
        "restored": restored,
        "rounds": rounds,
        "final_outcome": final_outcome,
        "control_outcome": control_outcome,
    }
