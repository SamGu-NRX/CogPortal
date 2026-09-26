"""Verify the packaged golden application from outside the source tree."""

from __future__ import annotations

import os
import subprocess
import tempfile
import venv
from pathlib import Path


def main() -> None:
    """Install both wheels and discover the reference submission factories."""

    benchmark_wheels = sorted(Path("dist").glob("*.whl"))
    reference_wheels = sorted(Path("face_recognition_app/dist").glob("*.whl"))
    if len(benchmark_wheels) != 1 or len(reference_wheels) != 1:
        raise SystemExit("Expected one benchmark wheel and one reference-app wheel.")

    with tempfile.TemporaryDirectory(prefix="week2-reference-wheel-") as directory:
        root = Path(directory)
        environment = root / "venv"
        venv.EnvBuilder(with_pip=True).create(str(environment))
        scripts = environment / ("Scripts" if os.name == "nt" else "bin")
        python = scripts / ("python.exe" if os.name == "nt" else "python")
        subprocess.run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                str(benchmark_wheels[0].resolve()),
                str(reference_wheels[0].resolve()),
            ],
            check=True,
            cwd=str(root),
        )
        code = """
import importlib.metadata as metadata
points = {
    point.name: point.load()
    for point in metadata.entry_points().select(group='cogworks.submissions.v2')
}
assert set(points) == {'vision-recognition', 'vision-clustering'}
recognition = points['vision-recognition'](object())
clustering = points['vision-clustering'](object())
assert type(recognition).__name__ == 'FaceRecognitionApp'
assert type(clustering).__name__ == 'FaceRecognitionApp'
assert callable(recognition.process_image)
assert callable(clustering.cluster_images)
"""
        subprocess.run([str(python), "-c", code], check=True, cwd=str(root))


if __name__ == "__main__":
    main()
