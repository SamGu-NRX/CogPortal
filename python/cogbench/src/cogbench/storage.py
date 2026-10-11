from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .models import LocalReport


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
