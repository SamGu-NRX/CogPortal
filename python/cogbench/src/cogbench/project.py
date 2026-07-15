from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import List, Optional

from .models import RepositoryState


def _git(cwd: Path, args: List[str]) -> Optional[str]:
    try:
        result = subprocess.run(
            ["git"] + args,
            cwd=str(cwd),
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip()


def _github_full_name(remote: Optional[str]) -> Optional[str]:
    if not remote:
        return None
    match = re.search(r"github\.com(?::|/)([^/\s]+/[^/\s]+?)(?:\.git)?$", remote)
    return match.group(1) if match else None


def repository_state(cwd: Path) -> RepositoryState:
    sha = _git(cwd, ["rev-parse", "HEAD"])
    if sha and not re.fullmatch(r"[a-f0-9]{40}", sha):
        sha = None
    status = _git(cwd, ["status", "--porcelain"])
    remote = _git(cwd, ["remote", "get-url", "origin"])
    branch = _git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])
    return RepositoryState(
        repository_id=None,
        full_name=_github_full_name(remote),
        sha=sha,
        branch=branch or None,
        dirty=status is None or bool(status),
    )
