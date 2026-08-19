"""Week 1's version fields must agree with what the catalog and images say.

Three places restate the same facts, and nothing forces them to match: the
plugin's own attributes, the `benchmarks` row in the D1 migration, and the
runtime profile the job builder sends. A run job whose declared versions
disagree with the plugin is refused inside the sandbox by `_load_benchmark`,
which is the right place to catch it and the worst place to learn about it --
by then a student has spent an attempt on a 501.

Run in CI (`pnpm test:python`) so the disagreement is a red build instead.

    python scripts/validate_week1_submodule.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "benchmarks" / "week1" / "audio_identification_benchmark" / "plugins.py"
MIGRATION = ROOT / "apps" / "portal" / "migrations" / "0020_week1_audio.sql"
RUNNER = ROOT / "apps" / "portal" / "worker" / "execution" / "runner.ts"


def plugin_attribute(name: str) -> str:
    """Read one class attribute without importing numpy."""

    source = PLUGIN.read_text(encoding="utf-8")
    match = re.search(r"^\s+{} = (.+)$".format(re.escape(name)), source, re.M)
    if not match:
        raise SystemExit("{}: no attribute {}".format(PLUGIN, name))
    return match.group(1).strip().strip('"').strip("'")


def main() -> int:
    problems = []

    migration = MIGRATION.read_text(encoding="utf-8")
    if "'audio-identification'" not in migration:
        problems.append("{}: no audio-identification row".format(MIGRATION.name))

    # The scorer version is the one that must match: it names the formula, and
    # a changed formula with an unchanged name silently rescores history.
    scorer = plugin_attribute("scorer_version")
    if scorer and "'{}'".format(scorer) not in migration:
        problems.append(
            "plugin scorer_version {!r} is absent from {}".format(scorer, MIGRATION.name)
        )

    contract = plugin_attribute("contract_version")
    if "'{}'".format(contract) not in migration:
        problems.append(
            "plugin contract_version {!r} is absent from {}".format(contract, MIGRATION.name)
        )

    # Week 1 evaluates under the pinned 3.8 venv, so the job must say 3.8. If
    # this drifts to 3.11 the sandbox refuses the run with a version assertion
    # that reads as a platform fault.
    runner = RUNNER.read_text(encoding="utf-8")
    if "audio-identification" not in runner:
        problems.append("runner.ts does not name audio-identification in its runtime profile")
    elif not re.search(r'audio-identification"?\s*$|audio-identification"\s*\n\s*\?\s*"3\.8"',
                       runner, re.M):
        # Loose on purpose: the exact expression formatting is prettier's to
        # decide. What matters is that both the id and "3.8" appear together.
        window = runner[runner.index("audio-identification"): ]
        if '"3.8"' not in window[:400]:
            problems.append('runner.ts does not send pythonVersion "3.8" for audio-identification')

    active = re.search(r"active\s*\)?[^;]*?VALUES[^;]*?;", migration, re.S)
    if active and re.search(r",\s*0\s*\)", active.group(0)):
        print("note: the audio-identification catalog row ships inactive.")

    if problems:
        print("Week 1 version restatements disagree:")
        for problem in problems:
            print("  - {}".format(problem))
        return 1
    print("Week 1 version restatements agree.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
