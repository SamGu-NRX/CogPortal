"""Which files of a source tree an image copy leaves out.

One rule for three readers: the image definitions (`modal_app.add_source_dir`),
the release probe's accepted-source manifest, and the submodule validators'
dirty-tree check. Each used to restate it, and a restatement that drifts either
refuses a correct image or lets a file into one unchecked.

Standard library only, so the validators can import it on the course
interpreter without the runner's dependencies.
"""

from __future__ import annotations

from pathlib import PurePath

#: Directory names a source copy never carries, at any depth.
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


def is_build_junk(relative: PurePath) -> bool:
    """Modal's `ignore` predicate: True excludes the file.

    Modal calls it with each file's path relative to the copied directory.
    This used to be a list of patterns written as `"~=**/build"`. Modal reads
    a list as .dockerignore patterns and has no `~=` prefix, so every entry
    matched nothing and all of these directories were copied. A predicate has
    no pattern syntax to get wrong, and the tests can run it without Modal
    installed.
    """

    return relative.suffix == ".pyc" or any(
        part in BUILD_JUNK or part.endswith(".egg-info") for part in relative.parts
    )
