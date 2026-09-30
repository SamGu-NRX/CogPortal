from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from .models import LocalReport

#: A weight path is reported, stored and uploaded under this spelling, so it
#: has to survive a URL, an R2 key and a JSON field. 500 is the portal's own
#: limit (`LocalReportInputSchema`); the rest are characters that would make
#: one of those three mean something other than a file in the repository.
MAX_WEIGHT_PATH = 500

_READ_CHUNK = 1024 * 1024


def workspace_dir(root: Path) -> Path:
    """``<root>/.cogbench``, created ignoring itself.

    Everything the tool writes into a checkout lives here, and a directory
    git can see turns every local run into a dirty tree: measured on a fresh
    clone of a 2026 repository, one `cogworks run` left `?? .cogbench/` in
    `git status`, the report carried `dirty: true`, and hosted verification
    refuses a dirty report. The course template ignores the directory, but a
    repository that predates the template does not, so the directory carries
    its own ignore file the way `.pytest_cache` and `.ruff_cache` do.
    """

    directory = root / ".cogbench"
    directory.mkdir(parents=True, exist_ok=True)
    ignore = directory / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8")
    return directory


def reports_dir(cwd: Path) -> Path:
    return cwd / ".cogbench" / "reports"


def save_report(report: LocalReport, cwd: Path) -> Path:
    directory = workspace_dir(cwd) / "reports"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "{}.json".format(report.report_id)
    path.write_text(report.to_json() + "\n", encoding="utf-8")
    return path


class RetentionError(OSError):
    """A scored input could not be retained, or a retained one is not intact."""


@dataclass(frozen=True)
class RetainedInput:
    """One scored input, copied before it was loaded.

    ``path`` is the repository-relative name the report carries; ``sha256``
    and ``size`` are measured from the bytes that were copied, never from the
    original afterwards. ``retained`` is where those bytes now live.
    """

    path: str
    sha256: str
    size: int
    retained: Path


def weights_dir(root: Path) -> Path:
    """Where retained inputs live. Names the path; creates nothing.

    Reading a retained copy must not write to the checkout, and the creating
    form went through `workspace_dir`, which writes a `.gitignore`.
    """

    return Path(root) / ".cogbench" / "weights"


def _usable_name(name: str) -> bool:
    """Whether this is a path the report, the R2 key and the URL can carry.

    The raw segments, not `PurePosixPath.parts`: that collapses `a//b` and
    `a/./b` and drops a trailing slash, so a name would validate in a shape
    it was never stored or keyed under.
    """

    if not name or len(name) > MAX_WEIGHT_PATH:
        return False
    if name.startswith("/"):
        return False
    for part in name.split("/"):
        if part in ("", ".", ".."):
            return False
        # DEL is a control character too, and PR24 rejects it.
        if "\\" in part or any(ord(c) < 32 or ord(c) == 127 for c in part):
            return False
    return True


def check_weight_path(name: str) -> str:
    """The saved name, or raise. Applied on the way out and on the way back."""

    if not _usable_name(name):
        raise RetentionError("Weight path is not a usable name: {!r}".format(name))
    return name


def canonical_weight_path(root: Path, source: Path) -> str:
    """The repository-relative name for ``source``, or raise.

    Relative to the project root the command was given, not to whichever
    nested directory discovery chose to search: the report, the upload key
    and the hosted checkout all describe the repository.
    """

    root = Path(root).resolve()
    resolved = Path(source).resolve()
    try:
        relative = resolved.relative_to(root)
    except ValueError:
        raise RetentionError(
            "Weight file is outside the project: {}".format(source)
        ) from None
    return check_weight_path(relative.as_posix())


def _verified_weights_dir(root: Path) -> Path:
    """`<root>/.cogbench/weights`, created only through checked components.

    Each level is refused if it is already a symlink, and refused before it is
    created or written through, so a link planted at `.cogbench`, `weights` or
    any digest directory cannot redirect a write out of the workspace.
    """

    current = Path(root)
    for part in (".cogbench", "weights"):
        current = current / part
        if current.is_symlink():
            raise RetentionError(
                "Refusing to use {}: the workspace contains a symlink.".format(current)
            )
        current.mkdir(parents=True, exist_ok=True)
    # `workspace_dir` writes the self-ignoring `.gitignore` when it is absent,
    # and a dangling symlink reads as absent, so the write would follow it out
    # of the workspace. Checked here rather than there, because this is the
    # path that creates the directory.
    ignore = Path(root) / ".cogbench" / ".gitignore"
    if ignore.is_symlink():
        raise RetentionError(
            "Refusing to use {}: the workspace contains a symlink.".format(ignore)
        )
    workspace_dir(root)
    return current


def _refuse_symlinks(root: Path, path: Path) -> None:
    """No component under the workspace may be a symlink, reading or writing.

    The workspace belongs to this tool, so a link inside it is either a
    mistake or an attempt to make us write through it. Either way the honest
    answer is to stop rather than to follow it.
    """

    # Built from the same unresolved root the caller used, because resolving
    # one side and not the other makes every path look foreign on a platform
    # where the temporary directory is itself a link.
    current = Path(root)
    for part in path.relative_to(current).parts:
        current = current / part
        if current.is_symlink():
            raise RetentionError(
                "Refusing to use {}: the workspace contains a symlink.".format(current)
            )


def retain_input(root: Path, source: Path) -> RetainedInput:
    """Copy one selected input before anything loads it, and measure the copy.

    The digest and the length come from the bytes written here, so the
    receipt describes the copy that was handed to the week. Reading the
    original again later would describe whatever it holds then, which is the
    defect this exists to remove.

    The destination keeps the file's own name below the digest, because the
    loaders route on it: ``load_weight_file`` picks ``np.load`` from a
    ``.npy`` suffix, and a team's own ``load`` may inspect the name too.
    """

    source = Path(source)
    # `prepare` runs from a scratch directory, so a relative name here would
    # resolve against that instead of the project and retain the wrong file,
    # or nothing. The week knows the absolute path; it has to pass it.
    if not source.is_absolute():
        raise RetentionError(
            "Weight file must be given as an absolute path: {}".format(source)
        )
    if source.is_symlink():
        raise RetentionError("Weight file is a symlink: {}".format(source))
    if not source.is_file():
        raise RetentionError("Weight file does not exist: {}".format(source))
    name = canonical_weight_path(root, source)

    # Verified before anything is created, so a planted link cannot take the
    # first write. The staging name is created by mkstemp rather than chosen,
    # so it cannot already be a link either.
    directory = _verified_weights_dir(root)
    handle, staging_name = tempfile.mkstemp(prefix=".incomplete-", dir=str(directory))
    staging = Path(staging_name)
    digest = hashlib.sha256()
    size = 0
    try:
        with source.open("rb") as reader, os.fdopen(handle, "wb") as writer:
            while True:
                chunk = reader.read(_READ_CHUNK)
                if not chunk:
                    break
                digest.update(chunk)
                size += len(chunk)
                writer.write(chunk)
        checksum = digest.hexdigest()
        destination = directory / checksum / name
        _refuse_symlinks(root, destination.parent)
        destination.parent.mkdir(parents=True, exist_ok=True)
        _refuse_symlinks(root, destination)
        # Always the bytes just hashed, even when something is already at this
        # address. Keeping whatever is there would mean serving a cached file
        # nothing in this run verified, and the digest would then be a claim
        # about bytes this run never read.
        os.replace(str(staging), str(destination))
    finally:
        # Only an interrupted write of our own is cleaned up here. Retained
        # inputs stay until the student removes the workspace.
        try:
            staging.unlink()
        except OSError:
            pass
    return RetainedInput(path=name, sha256=checksum, size=size, retained=destination)


def retained_input(root: Path, path: str, sha256: str, size: int) -> Path:
    """The retained copy named by a saved receipt, verified against it.

    A mismatch is a failure, never a reason to adopt whatever is there now:
    the report already published this digest, and uploading different bytes
    under it would make the report a false statement about the run.
    """

    check_weight_path(path)
    if len(sha256) != 64 or any(c not in "0123456789abcdef" for c in sha256):
        raise RetentionError("Weight digest is not a SHA-256: {!r}".format(sha256))
    directory = weights_dir(root) / sha256
    destination = directory / path
    # Belt as well as the name check: the file that is read has to be the one
    # inside the directory this digest names.
    try:
        destination.resolve().relative_to(directory.resolve())
    except (ValueError, OSError):
        raise RetentionError(
            "Refusing to read {} from outside its retained directory.".format(path)
        ) from None
    _refuse_symlinks(root, destination)
    if not destination.is_file():
        raise RetentionError(
            "The retained copy of {} is missing from this workspace; "
            "run the benchmark again to recapture it.".format(path)
        )
    actual_size = destination.stat().st_size
    digest = hashlib.sha256()
    with destination.open("rb") as stream:
        while True:
            chunk = stream.read(_READ_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    actual = digest.hexdigest()
    if actual_size != size or actual != sha256:
        raise RetentionError(
            "The retained copy of {} no longer matches the report "
            "({} bytes, {}); run the benchmark again.".format(path, actual_size, actual)
        )
    return destination


def latest_report(cwd: Path) -> Optional[Path]:
    directory = reports_dir(cwd)
    if not directory.exists():
        return None
    reports = sorted(directory.glob("local_*.json"), key=lambda path: path.stat().st_mtime)
    return reports[-1] if reports else None


def config_path() -> Path:
    override = os.environ.get("COGBENCH_CONFIG")
    return Path(override).expanduser() if override else Path.home() / ".cogbench" / "config.json"


def load_config() -> Dict[str, Any]:
    path = config_path()
    if not path.exists():
        return {"portals": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def save_token(portal: str, token: str, expires_at: int) -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    config = load_config()
    config.setdefault("portals", {})[portal] = {"token": token, "expiresAt": expires_at}
    config["activePortal"] = portal
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(
        json.dumps(config, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    try:
        temporary.chmod(0o600)
    except OSError:
        pass
    os.replace(str(temporary), str(path))


def token_for(portal: str) -> Optional[str]:
    entry = load_config().get("portals", {}).get(portal)
    if not isinstance(entry, dict):
        return None
    expires_at = entry.get("expiresAt")
    if not isinstance(expires_at, int) or expires_at <= int(time.time() * 1000):
        return None
    token = entry.get("token")
    return token if isinstance(token, str) else None


def active_portal() -> Optional[str]:
    value = load_config().get("activePortal")
    return value if isinstance(value, str) and value else None
