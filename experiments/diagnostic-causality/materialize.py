"""Materialize variant projects from the frozen control plus key patches.

This is the only module in the study that reads key.json, and it runs before
any measurement: the subject (cogbench) sees finished project directories and
never the key. Every variant is a fresh copy of the control with one or more
defect patches applied.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

STUDY = Path(__file__).resolve().parent
CONTROL = STUDY / "fixtures" / "control"
KEY = STUDY / "key.json"


def load_key() -> dict:
    with open(KEY, encoding="utf-8") as handle:
        return json.load(handle)


def apply_patch(source: str, patch: list) -> str:
    text = source
    for step in patch:
        op = step["op"]
        if op == "replace":
            find = step["find"]
            count = int(step.get("count", 1))
            if text.count(find) < count:
                raise ValueError(f"patch find-string not present: {find[:60]!r}")
            text = text.replace(find, step["replace"], count)
        elif op == "remove_line":
            find = step["find"]
            lines = text.splitlines(keepends=True)
            kept = [ln for ln in lines if ln.strip() != find.strip()]
            if len(kept) == len(lines):
                raise ValueError(f"remove_line not found: {find!r}")
            text = "".join(kept)
        elif op == "insert_line":
            after, line = step["after"], step["line"]
            anchor = after if after.endswith("\n") else after + "\n"
            if anchor not in text:
                raise ValueError(f"insert_line anchor not found: {after!r}")
            text = text.replace(anchor, anchor + line + "\n", 1)
        else:
            raise ValueError(f"unknown patch op: {op}")
    return text


def variant_specs(key: dict) -> dict:
    """variant name -> list of patches (single- and multi-defect)."""
    specs = {}
    for defect_id, entry in key["defects"].items():
        specs[defect_id] = [(defect_id, entry["patch"])]
    for multi_id, members in key["multi_defect"].items():
        patches = []
        for defect_id in members:
            patches.append((defect_id, key["defects"][defect_id]["patch"]))
        specs[multi_id] = patches
    return specs


def materialize(work_root: Path, key: dict) -> dict:
    """Build control + every variant under work_root. Returns {name: path}."""
    work_root.mkdir(parents=True, exist_ok=True)
    control_src = (CONTROL / "submission.py").read_text(encoding="utf-8")
    paths = {}

    control_dir = work_root / "control"
    if control_dir.exists():
        shutil.rmtree(control_dir)
    control_dir.mkdir()
    (control_dir / "submission.py").write_text(control_src, encoding="utf-8")
    paths["control"] = control_dir

    for name, patches in variant_specs(key).items():
        vdir = work_root / name
        if vdir.exists():
            shutil.rmtree(vdir)
        vdir.mkdir()
        text = control_src
        for _defect_id, patch in patches:
            text = apply_patch(text, patch)
        (vdir / "submission.py").write_text(text, encoding="utf-8")
        paths[name] = vdir
    return paths


def single_defect_names(key: dict) -> list:
    return list(key["defects"].keys())


def multi_defect_names(key: dict) -> list:
    return list(key["multi_defect"].keys())
