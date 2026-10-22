"""The README's documented commands reproduce the committed evidence.

Each build, verify and reader-checks command in the README's Running
block is run as written, from the repository root, except that its
``--out`` points at a temporary copy of the committed artifact. The
replay gate must validate the copy and leave every byte as committed.
"""

import shlex
import shutil
import subprocess
import sys
from pathlib import Path

WORKBENCH = Path(__file__).resolve().parents[1]
REPO_ROOT = WORKBENCH.parents[1]
README = WORKBENCH / "README.md"
TOOLS = {
    "tools/run-comparison/build.py",
    "tools/run-comparison/verify.py",
    "tools/run-comparison/reader_checks.py",
}


def _readme_commands():
    text = README.read_text(encoding="utf-8")
    block = text.split("## Running", 1)[1].split("```", 2)[1]
    joined = block.replace("\\\n", " ")
    commands = []
    for line in joined.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        argv = shlex.split(line)
        if argv[0] == "python" and len(argv) > 1 and argv[1] in TOOLS:
            commands.append(argv)
    return commands


def _snapshot(path):
    if path.is_file():
        return {path.name: path.read_bytes()}
    return {
        entry.relative_to(path).as_posix(): entry.read_bytes()
        for entry in sorted(path.rglob("*"))
        if entry.is_file() and not entry.name.startswith(".")
    }


def test_readme_replay_commands_reproduce_the_committed_evidence(tmp_path):
    commands = [argv for argv in _readme_commands() if "--force" not in argv]
    tools = sorted(Path(argv[1]).name for argv in commands)
    assert tools == [
        "build.py",
        "build.py",
        "reader_checks.py",
        "verify.py",
        "verify.py",
    ], commands

    copies = {}
    for argv in commands:
        out = argv[argv.index("--out") + 1]
        if out in copies:
            continue
        committed = REPO_ROOT / out
        copy = tmp_path / "copy-{}".format(len(copies)) / committed.name
        copy.parent.mkdir()
        if committed.is_dir():
            shutil.copytree(committed, copy)
        else:
            shutil.copy2(committed, copy)
        copies[out] = (committed, copy)

    for argv in commands:
        out_index = argv.index("--out") + 1
        run = [sys.executable, *argv[1:]]
        run[out_index] = str(copies[argv[out_index]][1])
        done = subprocess.run(
            run, capture_output=True, text=True, cwd=str(REPO_ROOT)
        )
        assert done.returncode == 0, (argv, done.stdout, done.stderr)
        if argv[1].endswith("build.py"):
            assert "existing evidence validated against a fresh build" in done.stdout

    for committed, copy in copies.values():
        assert _snapshot(copy) == _snapshot(committed), committed
