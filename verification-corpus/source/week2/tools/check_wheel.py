from __future__ import annotations

import os
import subprocess
import tempfile
import venv
from pathlib import Path


def main() -> None:
    wheels = sorted(Path("dist").glob("*.whl"))
    if len(wheels) != 1:
        raise SystemExit("Expected exactly one wheel in dist/.")
    wheel = wheels[0].resolve()
    with tempfile.TemporaryDirectory(prefix="week2-wheel-") as directory:
        root = Path(directory)
        environment = root / "venv"
        venv.EnvBuilder(with_pip=True).create(str(environment))
        scripts = environment / ("Scripts" if os.name == "nt" else "bin")
        python = scripts / ("python.exe" if os.name == "nt" else "python")
        subprocess.run([str(python), "-m", "pip", "install", str(wheel)], check=True, cwd=str(root))
        code = """
import importlib.metadata as metadata
import importlib.resources as resources
points = {
    point.name: point.load()
    for point in metadata.entry_points().select(group='cogworks.benchmarks.v2')
}
assert set(points) == {'vision-recognition', 'vision-clustering'}
assert points['vision-recognition']().benchmark_version == 2
assert points['vision-clustering']().benchmark_version == 2
assert resources.files('facial_recognition_benchmark').joinpath('model-lock.json').is_file()
"""
        subprocess.run([str(python), "-c", code], check=True, cwd=str(root))


if __name__ == "__main__":
    main()
