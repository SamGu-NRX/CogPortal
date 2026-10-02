"""Refuse a benchmark checkout whose files are not exactly its reviewed commit.

Each `validate_weekN_submodule.py` already checks that the submodule's HEAD is
the reviewed commit. HEAD says nothing about the working tree, and the images
copy the working tree (`modal_app.add_source_dir`) and `pip install` from it.
The 2026-10-02 provenance audit edited only the labels in Week 2's tracked
public-evaluation.json, which moved practice pairwise F1 from 1.0 to 0.0 while
the HEAD check and every version restatement still passed.

So any modified, deleted or untracked file fails, except the build output the
image copy itself leaves behind. Untracked files count because they are copied
too, and one at the root (a `setup.cfg`) can change what pip installs.

Python 3.8, standard library only: the week lanes run this on the course
interpreter without the runner installed.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import List

#: Must equal `modal_app.BUILD_JUNK`; `test_source_copy` compares the two,
#: because the runner is not importable where these validators run.
BUILD_JUNK = frozenset(
    {
        "__pycache__",
        ".pytest_cache",
        ".ruff_cache",
        ".mypy_cache",
        ".git",
        ".venv",
        "build",
        "dist",
    }
)


def is_build_junk(relative: Path) -> bool:
    """The image copy's own exclusion rule, `modal_app.is_build_junk`."""

    return relative.suffix == ".pyc" or any(
        part in BUILD_JUNK or part.endswith(".egg-info") for part in relative.parts
    )


def differences(benchmark: Path) -> List[str]:
    """Paths whose state differs from HEAD, as `git status` names them."""

    output = subprocess.check_output(
        [
            "git", "-C", str(benchmark), "status",
            "--porcelain=v1", "-z", "--untracked-files=all",
        ]
    ).decode("utf-8", "surrogateescape")
    entries = output.split("\0")
    changed = []
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if not entry:
            continue
        status, path = entry[:2], entry[3:]
        if status[0] in "RC":
            # -z puts a rename's source in the next field; both names matter.
            changed.append("{} (from {})".format(path, entries[index]))
            index += 1
            continue
        if status == "??" and is_build_junk(Path(path)):
            continue
        changed.append(path)
    return changed


def require_reviewed_tree(benchmark: Path, label: str) -> None:
    """SystemExit naming the differing paths, or None when the tree is HEAD."""

    changed = differences(benchmark)
    if changed:
        shown = ", ".join(changed[:10])
        if len(changed) > 10:
            shown += ", and {} more".format(len(changed) - 10)
        raise SystemExit(
            "{} differs from its reviewed commit: {}. The images copy and install "
            "this working tree, so these edits would be scored under the "
            "reviewed version. Commit them to the benchmark repository and bump "
            "the pin, or move them out of the checkout.".format(label, shown)
        )
