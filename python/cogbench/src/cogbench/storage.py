from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from .models import LocalReport


def reports_dir(cwd: Path) -> Path:
    return cwd / ".cogbench" / "reports"


def save_report(report: LocalReport, cwd: Path) -> Path:
    directory = reports_dir(cwd)
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
    config = load_config()
    config.setdefault("portals", {})[portal] = {"token": token, "expiresAt": expires_at}
    path.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def token_for(portal: str) -> Optional[str]:
    entry = load_config().get("portals", {}).get(portal)
    return entry.get("token") if isinstance(entry, dict) else None
