"""Publish an official dataset bundle under a version name exactly once.

A run records only the dataset version it was scored against, so the version
name has to keep meaning one set of bytes. The materializers used to delete an
existing version directory and install a replacement, which let two runs with
identical records be scored against different gold (the 2026-10-02 provenance
audit measured overall 1.0 against 0.61 that way). This module is the only
place the materializers write, and it never replaces or edits a directory that
already exists:

- absent: the bundle is written into a temporary sibling, the version
  directory is claimed with an exclusive `mkdir`, and each file is hard-linked
  in exclusively. A rename would be atomic but silently replaces an empty
  directory created after the existence check; these operations each fail
  instead. If linking fails part way, this call removes what it created;
  a crash in that window leaves a partial directory, which is refused below;
- present with the same contents: nothing is written;
- present with different contents, missing files, extra files, or not a plain
  directory: refused, and the existing bytes are left as they were.

"Same contents" compares each archive's member names and bytes rather than the
archive's own bytes, because `zipfile` stamps every member with the clock, so
materializing the same manifest twice never produces identical archives.

Python 3.8, standard library only: operators run this from the runner's
environment and its tests run on the course interpreter.
"""

from __future__ import annotations

import hashlib
import io
import os
import shutil
import stat
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Iterable, List, Mapping, Optional, Tuple, Union

PUBLISHED = "published"
UNCHANGED = "unchanged"

#: The bundle files are controller inputs, never edited after publication.
FILE_MODE = 0o440


class BundleRefused(RuntimeError):
    """The destination cannot take this bundle; nothing at it was changed."""


def require_usable_destination(target: Path, names: Iterable[str]) -> None:
    """Refuse a destination that could never accept a bundle, before building one.

    Building a bundle can mean downloading a dataset, so an incomplete or
    foreign directory at the destination is reported first. A complete
    existing bundle passes; whether it matches is only known once the new
    contents exist.
    """

    _existing_files(target, sorted(names))


def publish_bundle(target: Path, files: Mapping[str, bytes]) -> str:
    """Write `files` as the bundle at `target`, or confirm it is already there.

    Returns PUBLISHED or UNCHANGED, and raises BundleRefused for every other
    outcome. Nothing under an existing `target` is written, moved or removed.
    """

    names = sorted(files)
    if not names or any(_unsafe_name(name) for name in names):
        raise BundleRefused("A bundle needs at least one plain file name.")
    if _existing_files(target, names) is not None:
        return _confirm_same(target, files)

    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(
        tempfile.mkdtemp(prefix=".{}.".format(target.name), dir=str(target.parent))
    )
    try:
        for name in names:
            path = temporary / name
            path.write_bytes(files[name])
            path.chmod(FILE_MODE)
        try:
            os.mkdir(str(target))
        except FileExistsError:
            # Another materialization got there first: the same answer as if
            # it had finished before this one started.
            if _existing_files(target, names) is None:
                raise BundleRefused(
                    "{} appeared and vanished while publishing. Nothing was "
                    "written; run the materializer again.".format(target)
                ) from None
            return _confirm_same(target, files)
        _link_into(temporary, target, names)
    finally:
        # Only this call's own temporary directory; the links keep the bytes.
        # A failure here is reported, never raised: it must not replace the
        # outcome above, and a silent leftover is a second copy of the data.
        try:
            shutil.rmtree(str(temporary))
        except OSError as error:
            print(
                "bundle warning: a temporary copy remains at {}: {}.".format(
                    temporary, error.strerror or error
                ),
                file=sys.stderr,
            )
    return PUBLISHED


def _link_into(source: Path, target: Path, names: List[str]) -> None:
    """Fill a directory this call just created, or leave nothing behind."""

    linked = []
    try:
        for name in names:
            # link(2) fails rather than replacing a file already at the name.
            os.link(str(source / name), str(target / name))
            linked.append(target / name)
    except OSError as error:
        # Each step guarded: a cleanup failure must not replace the failure
        # that caused it, and is reported beside it instead.
        left = []
        for path in linked:
            try:
                os.unlink(str(path))
            except OSError:
                left.append(path.name)
        try:
            os.rmdir(str(target))
            residue = ""
        except OSError:
            residue = " {} could not be removed{}; inspect it before publishing again.".format(
                target, " (still holds {})".format(", ".join(left)) if left else ""
            )
        raise BundleRefused(
            "Could not publish {}: {}.{}".format(target, error.strerror or error, residue)
        ) from None


def _existing_files(target: Path, names: List[str]) -> Optional[List[str]]:
    """None when nothing is at `target`; the names when it is a complete bundle."""

    try:
        status = os.lstat(str(target))
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(status.st_mode):
        raise BundleRefused(
            "{} exists and is not a plain directory. It was left untouched; "
            "materialize under a new --dataset-version.".format(target)
        )
    present = sorted(entry.name for entry in os.scandir(str(target)))
    if present != names:
        missing = sorted(set(names) - set(present))
        extra = sorted(set(present) - set(names))
        raise BundleRefused(
            "{} already exists but is not a complete bundle (missing: {}; "
            "unexpected: {}). It was left untouched. Runs may already have read "
            "it, so materialize under a new --dataset-version rather than "
            "repairing it in place.".format(
                target, ", ".join(missing) or "none", ", ".join(extra) or "none"
            )
        )
    for name in names:
        if not stat.S_ISREG(os.lstat(str(target / name)).st_mode):
            raise BundleRefused(
                "{} is not a regular file. The bundle was left untouched; "
                "materialize under a new --dataset-version.".format(target / name)
            )
    return names


def _confirm_same(target: Path, files: Mapping[str, bytes]) -> str:
    different = [
        name
        for name in sorted(files)
        if _identity(name, (target / name).read_bytes(), target)
        != _identity(name, files[name], target)
    ]
    if different:
        raise BundleRefused(
            "{} already holds this dataset version with different contents "
            "({} differ). Runs scored against it record only the version name, "
            "so replacing it would change what those records mean. It was left "
            "untouched; materialize under a new --dataset-version.".format(
                target, ", ".join(different)
            )
        )
    return UNCHANGED


def _identity(name: str, data: bytes, target: Path) -> Union[str, Tuple[Tuple[str, str], ...]]:
    """What "same contents" compares for one bundle file."""

    if not name.endswith(".zip"):
        return hashlib.sha256(data).hexdigest()
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = archive.infolist()
            # Reading by name returns the last of two same-named entries, so
            # two different archives could compare equal; the encoders never
            # write duplicates, so one is refused rather than interpreted.
            if len({member.filename for member in members}) != len(members):
                raise BundleRefused(
                    "{} in {} repeats an archive member name. The bundle was left "
                    "untouched; materialize under a new --dataset-version.".format(name, target)
                )
            return tuple(
                (member.filename, hashlib.sha256(archive.read(member)).hexdigest())
                for member in members
            )
    except zipfile.BadZipFile:
        raise BundleRefused(
            "{} in {} is not a readable archive. The bundle was left untouched; "
            "materialize under a new --dataset-version.".format(name, target)
        ) from None


def _unsafe_name(name: str) -> bool:
    return not name or name in (".", "..") or "/" in name or os.sep in name
