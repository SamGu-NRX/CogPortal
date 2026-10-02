"""Refuse a benchmark checkout whose files are not exactly its reviewed commit.

Each `validate_weekN_submodule.py` already checks that the submodule's HEAD is
the reviewed commit. HEAD says nothing about the working tree, and the images
copy the working tree (`modal_app.add_source_dir`) and `pip install` from it.
The 2026-10-02 provenance audit edited only the labels in Week 2's tracked
public-evaluation.json, which moved practice pairwise F1 from 1.0 to 0.0 while
the HEAD check and every version restatement still passed.

So any modified, deleted, untracked or git-ignored file fails, except the
build output the image copy itself leaves behind. Untracked and ignored files
count because the copy does not read .gitignore, and one at the root (a
`setup.cfg`) can change what pip installs.

Python 3.8, standard library only: the week lanes run this on the course
interpreter without the runner installed.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import List

# The image copy's own exclusion rule, read from the runner rather than
# restated: it is standard library only, so this works on the course
# interpreter where the runner's dependencies are not installed.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "runner-modal" / "src"))
from cogworks_runner.source_tree import is_build_junk  # noqa: E402


def differences(benchmark: Path) -> List[str]:
    """Paths whose state differs from HEAD, as `git status` names them."""

    output = subprocess.check_output(
        [
            "git", "-C", str(benchmark), "status",
            "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=traditional",
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
        if "R" in status or "C" in status:
            # -z puts a rename's source in the next field, whether the rename
            # is staged (first column) or not (second); both names matter.
            changed.append("{} (from {})".format(path, entries[index]))
            index += 1
            continue
        # Only files git does not track can be build output; a tracked file
        # under build/ that changed is still a changed file.
        if status in ("??", "!!") and is_build_junk(Path(path)):
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
