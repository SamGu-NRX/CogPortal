"""Week 1's version fields must agree with what the catalog and images say.

Three places restate the same facts, and nothing forces them to match: the
plugin's own attributes, the `benchmarks` row in the D1 migration, and the
runtime profile the job builder sends. A run job whose declared versions
disagree with the plugin is refused inside the sandbox by `_load_benchmark`,
which is the right place to catch it and the worst place to learn about it --
by then a student has spent an attempt on a 501.

Run in CI (`pnpm test:python`) so the disagreement is a red build instead.

    python scripts/validate_week1_submodule.py

`--self-test` proves the pythonVersion check on an in-memory mutation of
runner.ts instead of validating the tree.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BENCHMARK = ROOT / "benchmarks" / "week1"
PLUGIN = BENCHMARK / "audio_identification_benchmark" / "plugins.py"
MIGRATIONS = ROOT / "apps" / "portal" / "migrations"
MIGRATION = MIGRATIONS / "0020_week1_audio.sql"
RUNNER = ROOT / "apps" / "portal" / "worker" / "execution" / "runner.ts"

REVIEWED_COMMIT = "61ef56ebb14a47419ad9b27c79dfdd82aca798f2"

# The literal values reviewed into 0020_week1_audio.sql. Checked against
# every migration, not that file: a later migration rewriting the row is
# exactly the change this list exists to surface.
MIGRATION_EXPECTATIONS = (
    "'audio-identification'",
    "'synth-v1'",
    "'week1-cpu-v1'",
    "'identification_score'",
)


def plugin_attribute(name: str) -> str:
    """Read one class attribute without importing numpy."""

    source = PLUGIN.read_text(encoding="utf-8")
    match = re.search(r"^\s+{} = (.+)$".format(re.escape(name)), source, re.M)
    if not match:
        raise SystemExit("{}: no attribute {}".format(PLUGIN, name))
    return match.group(1).strip().strip('"').strip("'")


def _expression_after(source: str, start: int) -> str:
    """Take the property value starting at `start`, ending at the comma that
    sits at the expression's own bracket depth. Prettier only moves
    whitespace, which cannot move this boundary; a string literal cannot
    fake it because quoted text is skipped."""

    depth = 0
    quote = None
    i = start
    while i < len(source):
        ch = source[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "\"'`":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                break
            depth -= 1
        elif ch == "," and depth == 0:
            break
        i += 1
    return source[start:i]


def check_python_version(runner: str) -> list[str]:
    """Verify the runtime profile sends pythonVersion "3.8" for
    audio-identification.

    Week 1 evaluates under the pinned 3.8 venv, so the job must say 3.8. If
    this drifts to 3.11 the sandbox refuses the run with a version assertion
    that reads as a platform fault.
    """

    match = re.search(r'\bpythonVersion"?\s*:', runner)
    if not match:
        return ["runner.ts has no pythonVersion field in its runtime profile"]
    expression = _expression_after(runner, match.end())
    if '"audio-identification"' not in expression:
        return [
            'runner.ts pythonVersion expression does not branch on '
            '"audio-identification"'
        ]
    flat = " ".join(expression.split())
    # The branch audio-identification selects must yield "3.8": a ternary ?
    # (the lookarounds exclude the ?? of the env fallback) directly followed
    # by the literal and the : that closes the branch. Collapsing whitespace
    # above makes this immune to prettier reflow; changing the value breaks
    # the match, so this cannot pass vacuously the way the old end-of-line
    # regex did.
    if not re.search(r'(?<!\?)\?(?!\?)\s*"3\.8"\s*:', flat):
        return [
            'runner.ts does not send pythonVersion "3.8" for audio-identification'
        ]
    return []


def main() -> int:
    if not (BENCHMARK / ".git").exists():
        raise SystemExit(
            "benchmarks/week1 is missing. Clone with --recurse-submodules or run "
            "git submodule update --init --recursive."
        )
    actual = subprocess.check_output(
        ["git", "-C", str(BENCHMARK), "rev-parse", "HEAD"], text=True
    ).strip()
    if actual != REVIEWED_COMMIT:
        raise SystemExit(
            "benchmarks/week1 is at {}, expected reviewed commit {}.".format(
                actual, REVIEWED_COMMIT
            )
        )

    problems = []

    # Every migration, not only 0020: a version bump lands as a new
    # migration by design, so pinning the file that introduced the row would
    # miss the exact change these checks exist to catch.
    migrations = "\n".join(
        path.read_text(encoding="utf-8") for path in sorted(MIGRATIONS.glob("*.sql"))
    )
    for value in MIGRATION_EXPECTATIONS:
        if value not in migrations:
            problems.append("no portal migration mentions {}".format(value))

    # The scorer version is the one that must match: it names the formula, and
    # a changed formula with an unchanged name silently rescores history.
    scorer = plugin_attribute("scorer_version")
    if scorer and "'{}'".format(scorer) not in migrations:
        problems.append(
            "plugin scorer_version {!r} is absent from the portal migrations".format(
                scorer
            )
        )

    contract = plugin_attribute("contract_version")
    if "'{}'".format(contract) not in migrations:
        problems.append(
            "plugin contract_version {!r} is absent from the portal migrations".format(
                contract
            )
        )

    problems.extend(check_python_version(RUNNER.read_text(encoding="utf-8")))

    # The active flag lives in the migration that introduced the row, so the
    # note reads that file alone; scanning every migration would match other
    # benchmarks' rows.
    active = re.search(
        r"active\s*\)?[^;]*?VALUES[^;]*?;",
        MIGRATION.read_text(encoding="utf-8"),
        re.S,
    )
    if active and re.search(r",\s*0\s*\)", active.group(0)):
        print("note: the audio-identification catalog row ships inactive.")

    if problems:
        print("Week 1 version restatements disagree:")
        for problem in problems:
            print("  - {}".format(problem))
        return 1
    print("Week 1 version restatements agree.")
    return 0


def self_test() -> int:
    """Mutation proof for check_python_version, in memory only.

    The check this replaced passed no matter what runner.ts said, because
    its first regex alternative matched the prettier-formatted condition
    line. So the test is: the real file passes, and the same text with
    "3.8" changed to "3.11" fails.
    """

    runner = RUNNER.read_text(encoding="utf-8")
    if check_python_version(runner):
        print("self-test: the real runner.ts should pass and does not")
        return 1
    mutated = runner.replace('"3.8"', '"3.11"')
    if mutated == runner:
        print('self-test: runner.ts no longer contains "3.8"; mutation is a no-op')
        return 1
    if not check_python_version(mutated):
        print('self-test: mutating "3.8" to "3.11" went undetected')
        return 1
    without_branch = runner.replace('benchmark.id === "audio-identification"', "false")
    if not check_python_version(without_branch):
        print("self-test: dropping the audio-identification branch went undetected")
        return 1
    print("self-test: pythonVersion check rejects both mutations.")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        raise SystemExit(self_test())
    raise SystemExit(main())
