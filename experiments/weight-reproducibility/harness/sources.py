"""Source-indexed provenance for the traced receipt contracts.

Every production file this experiment reads is resolved from the working tree
at run time and hashed from its actual bytes. Nothing here records a claim
about a source file that was not read this run: the digests are computed, not
invented, and ``assert_unchanged`` fails a run whose sources drifted from the
refs a prior result committed.
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

# role: what the traced contract says this file owns.
# - prepared_environment: schema-1 prepared-artifact receipt (bind + reuse
#   validation, field-presence and legacy reuse rules).
# - weight_sync_portal: owned-storage contract (content-addressed keys,
#   repository spellings, legacy pre-digest keys, checksum-bound writes).
# - weight_sync_runner: the runner-side download loop (chunked sha256, size
#   then digest refusal).
# - protocol: the WeightFile record {path, size, sha256} both sides exchange.
PRODUCTION_SOURCES = {
    "prepared_environment": (
        "apps/runner-modal/src/cogworks_runner/prepared_environment.py",
        "schema-1 prepared-artifact receipt: field set, weight records, reuse rules",
    ),
    "weight_sync_portal": (
        "apps/portal/worker/services/weights.ts",
        "owned-storage weight sync: content-addressed keys, spellings, legacy keys",
    ),
    "weight_sync_runner": (
        "apps/runner-modal/src/cogworks_runner/modal_app.py",
        "runner preparation: streamed download, chunked sha256, size+digest refusal",
    ),
    "protocol": (
        "packages/contracts/src/protocol.ts",
        "WeightFile wire record shared by portal and runner",
    ),
}

_BASE_BRANCH = "fix/device-link-recovery-20261004"


def _git(*args: str) -> str:
    out = subprocess.run(
        ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=True
    )
    return out.stdout.strip()


def head_sha() -> str:
    return _git("rev-parse", "HEAD")


def source_refs() -> list[dict]:
    """Hash every traced production file from the tree, as of this run."""
    refs = []
    for name, (rel, role) in sorted(PRODUCTION_SOURCES.items()):
        path = REPO_ROOT / rel
        refs.append(
            {
                "name": name,
                "path": rel,
                "role": role,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    return refs


def assert_unchanged(refs: list[dict]) -> None:
    """Fail if a recorded source ref no longer matches the working tree."""
    current = {row["name"]: row["sha256"] for row in source_refs()}
    for row in refs:
        if current.get(row["name"]) != row["sha256"]:
            raise SystemExit(
                f"source ref drifted: {row['name']} "
                f"recorded {row['sha256'][:12]} now {current.get(row['name'], '?')[:12]}"
            )


def load_prepared_environment_module():
    """Import the production receipt module by path, not by package.

    ``cogworks_runner/__init__`` pulls in runner machinery this experiment must
    not execute; ``prepared_environment.py`` itself imports only the standard
    library, so loading it standalone gives the real validator without the
    package side effects.
    """
    import importlib.util

    rel, _ = PRODUCTION_SOURCES["prepared_environment"]
    path = REPO_ROOT / rel
    spec = importlib.util.spec_from_file_location("prepared_environment_production", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
