"""Print exactly what each hosted image installs, by watching it get built.

    python apps/runner-modal/tools/image_manifest.py

An image is a chain of Modal builder calls, so what it installs is not written
down anywhere as a list; it is the result of running that chain. This records
the chain instead of executing it: `modal` and `fastapi` are replaced with
stand-ins that remember every call, `modal_app` is imported, and each
`*_image` object then holds the literal arguments its builders received.

Two uses. Run it before and after a change to the image definitions and diff
the output, which is how the move of the package lists into
`cogbench.environment` was shown to leave every image byte-identical. And run
it when you want to know what a graded run actually has, without waiting on a
build or reading a chain of method calls.

It cannot tell you the resolved dependency tree. `pip install scikit-image`
also installs networkx and tifffile, and only a real build knows the full set.
What this prints is the direct installs, which is what the manifest declares
and what the parity test checks.
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


class _Recorder:
    """A stand-in Modal image that remembers what it was asked to install.

    Every builder method returns a new recorder carrying the accumulated
    history, because Modal's builders are chained and each returns a fresh
    image rather than mutating one. Keeping them separate is what lets
    `controller_image`, which is built from `benchmark_image`, show its parent's
    installs as well as its own.
    """

    def __init__(self, history=()):
        self.history = list(history)

    def __getattr__(self, name):
        def _call(*args, **kwargs):
            if name == "pipe":
                # `.pipe(lambda i: ...)` hands the image to a function that
                # returns another image. Calling it keeps add_local_dir and
                # anything else inside the lambda in the recorded history.
                result = args[0](self)
                return result if isinstance(result, _Recorder) else self
            return _Recorder(self.history + [(name, args, kwargs)])

        return _call

    def installs(self):
        """Every literal requirement string this image passes to a installer.

        Covers both shapes the images use: `pip_install("a", "b")`, whose
        arguments are requirements one per string, and `run_commands("uv pip
        install ... 'a' 'b'")`, where they are quoted inside one shell line.
        """

        import re

        found = []
        for name, args, _kwargs in self.history:
            if name == "pip_install":
                found.extend(str(a) for a in args)
            elif name == "run_commands":
                for command in args:
                    if "pip install" not in str(command):
                        continue
                    if "--no-deps" in str(command):
                        # A local benchmark package installed from /opt/weekN.
                        # Not a course package and not on PyPI, so listing it
                        # among requirements would be misleading.
                        continue
                    found.extend(re.findall(r"'([^']+)'", str(command)))
        return found


def _stub_modules():
    """Put fake `modal` and `fastapi` in place before modal_app imports them.

    modal_app imports both at module scope, and neither is installed in the
    interpreter that runs the tests. Importing the real modal would also try to
    reach Modal's servers to resolve image references, which is not something a
    manifest dump should do.
    """

    modal = types.ModuleType("modal")
    modal.Image = types.SimpleNamespace(
        debian_slim=lambda **_kwargs: _Recorder(),
        from_name=lambda *_a, **_k: _Recorder(),
    )
    modal.App = lambda *_a, **_k: types.SimpleNamespace(
        function=lambda *_a, **_k: (lambda f: f),
        cls=lambda *_a, **_k: (lambda c: c),
        local_entrypoint=lambda *_a, **_k: (lambda f: f),
    )
    modal.Secret = types.SimpleNamespace(from_name=lambda *_a, **_k: object())
    modal.Volume = types.SimpleNamespace(from_name=lambda *_a, **_k: object())
    modal.Dict = types.SimpleNamespace(from_name=lambda *_a, **_k: object())
    modal.Sandbox = types.SimpleNamespace(create=lambda *_a, **_k: object())
    modal.is_local = lambda: True
    modal.enter = lambda *_a, **_k: (lambda f: f)
    modal.method = lambda *_a, **_k: (lambda f: f)
    modal.asgi_app = lambda *_a, **_k: (lambda f: f)
    modal.fastapi_endpoint = lambda *_a, **_k: (lambda f: f)
    modal.web_endpoint = lambda *_a, **_k: (lambda f: f)
    sys.modules["modal"] = modal

    fastapi = types.ModuleType("fastapi")
    fastapi.Request = object
    fastapi.Response = object
    fastapi.FastAPI = lambda *_a, **_k: types.SimpleNamespace()
    sys.modules["fastapi"] = fastapi


def manifest():
    """Each image's direct installs, keyed by the variable that defines it."""

    _stub_modules()
    sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))
    sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))
    from cogworks_runner import modal_app

    images = {}
    for name in dir(modal_app):
        if not name.endswith("_image"):
            continue
        value = getattr(modal_app, name)
        if isinstance(value, _Recorder):
            images[name] = sorted(set(value.installs()))
    return images


def main() -> int:
    print(json.dumps(manifest(), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
