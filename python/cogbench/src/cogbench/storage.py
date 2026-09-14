from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Dict, Optional

from .models import LocalReport


def _checkout_path(root: Path, path: Path) -> Path:
    """Reject preexisting symlinks below the supplied checkout root."""

    root = Path(root)
    path = Path(path)
    parts = path.relative_to(root).parts
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise OSError("refusing linked checkout storage path: {}".format(current))
    return path


def _report_filename(report_id: str) -> str:
    if (
        not report_id
        or "\0" in report_id
        or PurePosixPath(report_id).name != report_id
        or PureWindowsPath(report_id).name != report_id
        or report_id in (".", "..")
    ):
        raise OSError("report id is not a safe path component")
    return "{}.json".format(report_id)


def _replace_text(path: Path, text: str) -> None:
    """Replace an already-checked path without changing an existing hard link."""

    temporary: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=str(path.parent),
            prefix=path.name + ".",
            suffix=".tmp",
            delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write(text)
        temporary.replace(path)
        temporary = None
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass


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

    directory = _checkout_path(root, Path(root) / ".cogbench")
    directory.mkdir(parents=True, exist_ok=True)
    ignore = _checkout_path(root, directory / ".gitignore")
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8")
    elif not ignore.is_file():
        raise OSError("checkout ignore path is not a file: {}".format(ignore))
    return directory


def reports_dir(cwd: Path) -> Path:
    return _checkout_path(cwd, Path(cwd) / ".cogbench" / "reports")


def save_report(report: LocalReport, cwd: Path) -> Path:
    filename = _report_filename(report.report_id)
    workspace_dir(cwd)
    directory = reports_dir(cwd)
    directory.mkdir(parents=True, exist_ok=True)
    path = _checkout_path(cwd, directory / filename)
    _replace_text(path, report.to_json() + "\n")
    return path


def latest_report(cwd: Path) -> Optional[Path]:
    try:
        directory = reports_dir(cwd)
    except OSError:
        return None
    if not directory.is_dir():
        return None
    reports = [
        path
        for path in directory.glob("local_*.json")
        if not path.is_symlink() and path.is_file()
    ]
    reports.sort(key=lambda path: path.stat().st_mtime)
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
