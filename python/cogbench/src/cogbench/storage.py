"""Where ``cogworks`` keeps what it needs to remember between commands, in
two homes, both plain JSON and nothing else. Local reports go in
``.cogbench/reports/`` under the student's project, one file per run, so they
stay with the project that produced them and ``report``/``sync`` can default
to the newest. The linked-device credential goes in
``~/.cogbench/config.json`` (override with ``COGBENCH_CONFIG``), so one
``cogworks link`` covers every project on the machine. Nothing else in the
package creates or writes a file.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .models import LocalReport


def reports_dir(cwd: Path) -> Path:
    """Where one project's local reports collect, under the project itself.

    Reports belong to the directory a run happened in, so two checkouts never
    see each other's runs. Nothing is created here; ``save_report`` makes the
    directory on demand.
    """
    return cwd / ".cogbench" / "reports"


def save_report(report: LocalReport, cwd: Path) -> Path:
    """Write one local report as JSON and return the path it landed at.

    The directory is created on demand, so the first run in a fresh project
    needs no setup. The file is named after the report id and holds the
    report's ``to_json()`` plus one trailing newline; the CLI prints the
    returned path as the saved location.
    """
    directory = reports_dir(cwd)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "{}.json".format(report.report_id)
    path.write_text(report.to_json() + "\n", encoding="utf-8")
    return path


def latest_report(cwd: Path) -> Optional[Path]:
    """The project's newest local report, or ``None`` when there is none.

    Newest means the highest filesystem mtime, not the newest run: the
    timestamps recorded inside a report are never consulted, so a file that
    is copied or touched later decides which report counts as latest.
    ``None`` means the directory is missing or holds no ``local_*.json``
    files, which callers turn into "run something first".
    """
    directory = reports_dir(cwd)
    if not directory.exists():
        return None
    reports = sorted(directory.glob("local_*.json"), key=lambda path: path.stat().st_mtime)
    return reports[-1] if reports else None


def config_path() -> Path:
    """The credential file: ``$COGBENCH_CONFIG`` if set, else ``~/.cogbench/config.json``.

    An empty value counts as unset. The override gets ``~`` expansion and is
    otherwise taken as written.
    """
    override = os.environ.get("COGBENCH_CONFIG")
    return Path(override).expanduser() if override else Path.home() / ".cogbench" / "config.json"


def load_config() -> Dict[str, Any]:
    """The parsed credential file, or a fresh portal map when none exists yet.

    A missing file reads as never linked and returns ``{"portals": {}}``, so
    the first ``cogworks link`` needs no setup. A file that exists but is not
    valid JSON raises ``json.JSONDecodeError`` uncaught; this module neither
    repairs nor renames a damaged file.
    """
    path = config_path()
    if not path.exists():
        return {"portals": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def save_token(portal: str, token: str, expires_at: int) -> None:
    """Store one portal's device credential and make that portal active.

    The new config is written to a ``.tmp`` file beside the real one and then
    ``os.replace``d into place, so a crash mid-write leaves either the old
    config or the complete new one, never a half-written token. The directory
    gets mode 0700 and the file 0600 where the OS honors that, and a chmod
    failure never blocks the save. Entries for other portals are kept.
    """
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
    """The stored token for a portal, but only one that could still work.

    The token comes back only when the entry is a dict whose ``expiresAt``
    is an integer still in the future (milliseconds since epoch); anything
    else, including an expired or malformed entry, is ``None``. Callers
    treat ``None`` as "not linked" and point the student back at
    ``cogworks link``.
    """
    entry = load_config().get("portals", {}).get(portal)
    if not isinstance(entry, dict):
        return None
    expires_at = entry.get("expiresAt")
    if not isinstance(expires_at, int) or expires_at <= int(time.time() * 1000):
        return None
    token = entry.get("token")
    return token if isinstance(token, str) else None


def active_portal() -> Optional[str]:
    """The portal last linked on this machine, or ``None`` when never linked.

    The CLI reads this last, after ``--portal`` and ``COGPORTAL_URL``, so it
    is the default that lets a plain ``cogworks sync`` work after one link.
    Anything stored that is not a nonempty string counts as unlinked.
    """
    value = load_config().get("activePortal")
    return value if isinstance(value, str) and value else None
