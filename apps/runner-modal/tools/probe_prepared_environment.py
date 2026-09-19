"""Ask a freshly built sandbox image whether it can host an evaluation.

    python apps/runner-modal/tools/probe_prepared_environment.py \\
        --benchmark audio-identification \\
        --image-id im-XXXXXXXXXXXXXXXXXXXXXX \\
        --sandbox-contract 1 \\
        --receipt build/audio-receipt.json

`_prepare` runs this same compatibility probe, but only once a student has
already started a run against a published image. This runs it against one
image on demand, with no student and no evaluation.

A receipt records, for one image: the interpreter, that the SDK exposes the
entry points the evaluator calls, that the SDK, runner and benchmark packages
the sandbox imports are the accepted source, and that the image's declared
sandbox contract equals the catalog row.

Three refusals, each for a reason that is not obvious:

- **An image id, never a name.** `deploy.py` publishes names and
  `_sandbox_image` resolves them at dispatch, so a name can point at one image
  during the probe and another during a run.
- **The catalog contract from outside.** Reading `--sandbox-contract` from the
  image would compare the image against itself.
- **Imported modules, not paths that exist.** Manifests come from importing
  each package and walking where the import resolved, so a shadowed copy at
  the expected path cannot pass.

A receipt is not evidence on its own: require exit status 0 and check that it
names the image id and benchmark you intended.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "apps" / "runner-modal" / "src"))
sys.path.insert(0, str(REPO_ROOT / "python" / "cogbench" / "src"))

from cogbench.environment import PY38_VENV  # noqa: E402
from cogworks_runner.prepared_environment import (  # noqa: E402
    SANDBOX_CONTRACTS,
    PreparedEnvironmentError,
    student_python,
    validate_observation,
)

#: Separates an immutable object id from the mutable names deploy.py publishes.
IMAGE_ID = re.compile(r"im-[A-Za-z0-9]+\Z")

#: Platform trees, as (receipt key, module to import, accepted source, the root
#: that import must resolve to). The images copy `python/cogbench/src` to
#: `/opt/cogbench` and `apps/runner-modal/src` to `/opt/runner` and put both on
#: PYTHONPATH, so an import resolving anywhere else is a shadowed copy.
PLATFORM_TREES = (
    ("sdk", "cogbench", REPO_ROOT / "python" / "cogbench" / "src" / "cogbench", "/opt/cogbench/cogbench"),
    ("runner", "cogworks_runner", REPO_ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner", "/opt/runner/cogworks_runner"),
)

#: Benchmark package per track, as (submodule directory, package name). The
#: images `pip install` each benchmark, so the import resolves into
#: site-packages rather than to the copied source, and the root is therefore
#: not pinned; the package-relative files and hashes are what get compared.
#: Both Vision tracks are served by one package and one image.
BENCHMARK_PACKAGES = {
    "audio-identification": ("week1", "audio_identification_benchmark"),
    "vision-recognition": ("week2", "facial_recognition_benchmark"),
    "vision-clustering": ("week2", "facial_recognition_benchmark"),
    "language-search": ("week3", "language_search_benchmark"),
}

#: Runs inside the sandbox. Imports one package and walks the directory that
#: import resolved to, so the manifest describes what the interpreter loads
#: rather than what is on disk at a guessed path. 3.8 syntax, standard library
#: only: a pristine image is what is being measured.
MANIFEST_SCRIPT = r"""
import hashlib, importlib, json, os, sys

module = importlib.import_module(sys.argv[1])
root = os.path.dirname(os.path.abspath(module.__file__))
rows = []
for directory, _subdirectories, filenames in os.walk(root):
    for filename in sorted(filenames):
        if not filename.endswith(".py"):
            continue
        full = os.path.join(directory, filename)
        with open(full, "rb") as handle:
            payload = handle.read()
        rows.append({
            "path": os.path.relpath(full, root).replace(os.sep, "/"),
            "sha256": hashlib.sha256(payload).hexdigest(),
        })
rows.sort(key=lambda row: row["path"])
print(json.dumps({"root": root, "files": rows}, sort_keys=True, separators=(",", ":")))
"""

MANIFEST_REMOTE_PATH = "/tmp/cog-manifest.py"


class ProbeError(RuntimeError):
    """A refusal with a fixed, operator-readable reason."""


# ---------------------------------------------------------------------------
# Pure parts. These run without modal and without a network.
# ---------------------------------------------------------------------------


def benchmark_source(benchmark_id: str) -> Tuple[str, Path]:
    """The accepted package name and source directory for a track."""

    if benchmark_id not in BENCHMARK_PACKAGES:
        raise ProbeError("{} is not a known benchmark.".format(benchmark_id))
    week, package = BENCHMARK_PACKAGES[benchmark_id]
    return package, REPO_ROOT / "benchmarks" / week / package


def expected_trees(benchmark_id: str) -> List[Tuple[str, str, Path, Optional[str]]]:
    """Platform trees plus the one benchmark package this track serves.

    Deliberately not a repository walk. Only the packages the sandbox imports
    are compared, so datasets, tools and tests never enter a manifest.
    """

    package, source = benchmark_source(benchmark_id)
    return [
        (key, module, local, root) for key, module, local, root in PLATFORM_TREES
    ] + [("benchmark", package, source, None)]


def source_manifest(root: Path) -> List[Dict[str, str]]:
    """Every `.py` file under `root`, relative path and digest, sorted by path.

    Bounded to `.py`: the images copy these trees without `__pycache__` or
    `*.egg-info` (`modal_app.BUILD_JUNK`), and an installed package has bytecode
    the source tree does not, so a broader sweep would report differences that
    mean nothing.
    """

    if not root.is_dir():
        raise ProbeError("No source tree at {}.".format(root))
    rows = [
        {
            "path": path.relative_to(root).as_posix(),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        for path in sorted(root.rglob("*.py"))
    ]
    if not rows:
        raise ProbeError("Source tree {} holds no .py files.".format(root))
    return rows


def validate_manifest_payload(value: Any) -> Tuple[str, List[Dict[str, str]]]:
    """Refuse anything that is not a resolved root plus path/digest rows."""

    if (
        not isinstance(value, dict)
        or set(value) != {"root", "files"}
        or not isinstance(value["root"], str)
        or not value["root"].startswith("/")
    ):
        raise ProbeError("The image returned a manifest without a resolved import root.")
    files = value["files"]
    if not isinstance(files, list) or not files:
        raise ProbeError("The image returned no source manifest.")
    for row in files:
        if (
            not isinstance(row, dict)
            or set(row) != {"path", "sha256"}
            or not isinstance(row["path"], str)
            or not row["path"]
            or not isinstance(row["sha256"], str)
            or re.fullmatch("[a-f0-9]{64}", row["sha256"]) is None
        ):
            raise ProbeError("The image returned a malformed source manifest row.")
    return value["root"], files


def compare_manifests(
    expected: Sequence[Dict[str, str]], observed: Sequence[Dict[str, str]]
) -> Dict[str, List[str]]:
    """Three ways an installed tree can differ from the accepted source.

    Named separately because one edited file and a wholly different tree need
    to read differently.
    """

    expected_by_path = {row["path"]: row["sha256"] for row in expected}
    observed_by_path = {row["path"]: row["sha256"] for row in observed}
    return {
        "missingFromImage": sorted(set(expected_by_path) - set(observed_by_path)),
        "unexpectedInImage": sorted(set(observed_by_path) - set(expected_by_path)),
        "changed": sorted(
            path
            for path in set(expected_by_path) & set(observed_by_path)
            if expected_by_path[path] != observed_by_path[path]
        ),
    }


def manifest_matches(difference: Dict[str, List[str]]) -> bool:
    return not any(difference.values())


def catalog_job(benchmark_id: str, sandbox_contract: int) -> Dict[str, Any]:
    """The smallest job shape `validate_observation` reads."""

    return {"benchmark": {"id": benchmark_id, "sandboxContract": sandbox_contract}}


def validate_probe_inputs(benchmark_id: str, image_id: str, sandbox_contract: int) -> None:
    """Every check that can be made without the image, made before the image.

    Creating a sandbox and then refusing on an argument would bill for the
    answer to a question already decided.
    """

    if not IMAGE_ID.match(image_id or ""):
        raise ProbeError(
            "{!r} is not an immutable image id. Pass the `im-...` id the build "
            "printed, not a published name.".format(image_id)
        )
    if benchmark_id not in SANDBOX_CONTRACTS:
        raise ProbeError("{} is not a known benchmark.".format(benchmark_id))
    if sandbox_contract != SANDBOX_CONTRACTS[benchmark_id]:
        raise ProbeError(
            "The catalog says {} serves sandbox contract {}, and this source "
            "declares {}. Reconcile them before probing an image.".format(
                benchmark_id, sandbox_contract, SANDBOX_CONTRACTS[benchmark_id]
            )
        )


def reserve_receipt(path: Optional[Path]) -> None:
    """Refuse an occupied receipt path before anything is spent.

    A receipt is evidence about one image, so overwriting one destroys the
    record of a previous probe.

    `lexists`, not `exists`: a dangling symlink does not exist by the second
    test and still fails the exclusive create, so `exists` would pass here and
    refuse only after the sandbox had run.
    """

    if path is not None and os.path.lexists(str(path)):
        raise ProbeError(
            "{} already exists. Receipts are never overwritten; move or delete "
            "it first, or choose another path.".format(path)
        )


def write_receipt(path: Path, receipt: Dict[str, Any]) -> None:
    """Publish a complete receipt without replacing an existing destination.

    A same-directory hard link creates the final name exclusively after writing
    finishes. Cleanup removes only the temporary name, never the destination,
    which another process could replace before cleanup.
    """

    body = json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    directory = path.parent
    try:
        directory.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(
            dir=str(directory), prefix=".{}.".format(path.name), suffix=".part"
        )
    except OSError as error:
        raise ProbeError("Could not prepare {}: {}.".format(path, error)) from None

    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(body)
        os.link(temporary, str(path))
    except FileExistsError:
        residue = _discard(temporary)
        raise ProbeError(
            "{} appeared while this probe was running; nothing was written to it.{}".format(path, residue)
        ) from None
    except OSError as error:
        residue = _discard(temporary)
        raise ProbeError(
            "Could not write {}: {}.{}".format(path, error, residue)
        ) from None
    residue = _discard(temporary)
    if residue:
        print("probe warning: receipt is complete." + residue, file=sys.stderr)


def _discard(temporary: str) -> str:
    """Remove this call's own temporary file, reporting residue rather than raising.

    A cleanup failure must not replace the failure that caused it, so this
    returns a sentence to append instead of raising one.
    """

    try:
        os.unlink(temporary)
    except OSError as error:
        return " A temporary file remains at {}: {}.".format(temporary, error)
    return ""


def load_json(raw: str, what: str) -> Any:
    """Parse sandbox output as a refusal rather than a traceback.

    Malformed output is an expected provider failure. Only `ValueError` is
    caught, so a real defect keeps its traceback, and the payload is not echoed
    because it is unbounded and is not what a reader needs.
    """

    try:
        return json.loads(raw)
    except ValueError:
        raise ProbeError("The image returned output that is not JSON: {}.".format(what)) from None


def bind_modules_to_manifests(
    observation: Dict[str, Any], manifests: Dict[str, Dict[str, Any]]
) -> Dict[str, str]:
    """Match every module the compatibility probe imported to a manifest entry.

    Turns two independent readings into one claim. A module whose path lies
    under no manifest root came from somewhere else; a module whose hash
    differs from the manifest entry at the same path means the two readings
    disagree about one file. Either is a refusal.
    """

    roots = sorted(
        ((entry["root"].rstrip("/"), key) for key, entry in manifests.items()),
        key=lambda pair: len(pair[0]),
        reverse=True,
    )
    placed = {}
    for row in observation["modules"]:
        path = row["path"]
        for root, key in roots:
            if path == root or path.startswith(root + "/"):
                relative = path[len(root) + 1:] if path != root else ""
                entry = {item["path"]: item["sha256"] for item in manifests[key]["files"]}
                if relative not in entry:
                    raise ProbeError(
                        "{} imported {}, which the {} manifest does not "
                        "contain.".format(row["name"], path, key)
                    )
                if entry[relative] != row["sha256"]:
                    raise ProbeError(
                        "{} was imported from {} with a different hash than the "
                        "{} manifest reports for the same file.".format(
                            row["name"], path, key
                        )
                    )
                placed[row["name"]] = key
                break
        else:
            raise ProbeError(
                "{} was imported from {}, which is outside every checked "
                "package root ({}).".format(
                    row["name"], path, ", ".join(sorted(root for root, _key in roots))
                )
            )
    return placed


def build_receipt(
    benchmark_id: str,
    sandbox_contract: int,
    image_id: str,
    observation: Dict[str, Any],
    manifests: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Validate everything observed, then return the receipt, or raise.

    Fail-closed: a receipt exists only when every check passed. There is no
    partial receipt and no field recording a skipped check.
    """

    validate_probe_inputs(benchmark_id, image_id, sandbox_contract)
    try:
        validate_observation(catalog_job(benchmark_id, sandbox_contract), observation)
    except PreparedEnvironmentError as error:
        raise ProbeError(str(error)) from None

    for key, _module, _local, expected_root in expected_trees(benchmark_id):
        entry = manifests.get(key)
        if entry is None:
            raise ProbeError("The image returned no {} manifest.".format(key))
        if expected_root is not None and entry["root"].rstrip("/") != expected_root:
            raise ProbeError(
                "{} imported from {}, not {}. A shadowed copy would pass a path "
                "check and fail an import check.".format(key, entry["root"], expected_root)
            )
        if not manifest_matches(entry["difference"]):
            raise ProbeError(
                "The {} package in {} is not the accepted source: {} missing, "
                "{} unexpected, {} changed.".format(
                    key,
                    image_id,
                    len(entry["difference"]["missingFromImage"]),
                    len(entry["difference"]["unexpectedInImage"]),
                    len(entry["difference"]["changed"]),
                )
            )

    bound = bind_modules_to_manifests(observation, manifests)
    return {
        "schemaVersion": 1,
        "benchmarkId": benchmark_id,
        "catalogSandboxContract": sandbox_contract,
        "imageId": image_id,
        "studentPython": student_python(benchmark_id, PY38_VENV),
        "observation": observation,
        "importedModuleRoots": bound,
        "sourceManifests": {
            key: {"root": entry["root"], "files": entry["files"]}
            for key, entry in sorted(manifests.items())
        },
    }


# ---------------------------------------------------------------------------
# The part that talks to Modal, imported lazily so everything above stays
# testable where modal is not installed, which is where the tests run.
# ---------------------------------------------------------------------------


def observe_image(benchmark_id: str, image_id: str, timeout: int) -> Dict[str, Any]:
    """Run the compatibility probe and the manifest walks inside one sandbox.

    Network-blocked: a probe that could reach the network would not be
    measuring the environment an evaluation gets.
    """

    import modal  # noqa: PLC0415
    import modal.runner  # noqa: PLC0415

    interpreter = student_python(benchmark_id, PY38_VENV)
    app = modal.App("cogworks-runner-probe")
    observed = {}
    with modal.enable_output(), modal.runner.run_app(app):
        sandbox = modal.Sandbox.create(
            image=modal.Image.from_id(image_id),
            app=app,
            cpu=(0.5, 1),
            memory=(512, 2_048),
            timeout=timeout,
            block_network=True,
        )
        try:
            probe = sandbox.exec(
                interpreter, "-m", "cogworks_runner.prepared_environment", benchmark_id
            )
            probe.wait()
            if probe.returncode != 0:
                raise ProbeError(
                    "The image could not state its execution contract: {}".format(
                        (probe.stderr.read() or "").strip()[-400:]
                    )
                )
            observed["observation"] = load_json(
                probe.stdout.read(), "the compatibility probe's observation"
            )

            sandbox.filesystem.write_text(MANIFEST_SCRIPT, MANIFEST_REMOTE_PATH)
            manifests = {}
            for key, module, _local, _root in expected_trees(benchmark_id):
                walk = sandbox.exec(interpreter, MANIFEST_REMOTE_PATH, module)
                walk.wait()
                if walk.returncode != 0:
                    raise ProbeError(
                        "Could not import and read {} inside {}: {}".format(
                            module, image_id, (walk.stderr.read() or "").strip()[-400:]
                        )
                    )
                root, files = validate_manifest_payload(
                    load_json(walk.stdout.read(), "the {} manifest".format(key))
                )
                manifests[key] = {"root": root, "files": files}
            observed["manifests"] = manifests
        finally:
            sandbox.terminate()
    return observed


def probe_image(
    benchmark_id: str, image_id: str, sandbox_contract: int, timeout: int
) -> Dict[str, Any]:
    # Everything local first, including reading the accepted source. A missing
    # or empty tree is a mistake in this checkout, and finding it after the
    # sandbox has run would bill for an answer that was never usable.
    validate_probe_inputs(benchmark_id, image_id, sandbox_contract)
    expected = {
        key: source_manifest(local)
        for key, _module, local, _root in expected_trees(benchmark_id)
    }
    observed = observe_image(benchmark_id, image_id, timeout)
    manifests = {}
    for key, _module, _local, _root in expected_trees(benchmark_id):
        entry = observed["manifests"][key]
        manifests[key] = {
            "root": entry["root"],
            "files": entry["files"],
            # Against the manifests captured before the call, so the comparison
            # cannot pick up an edit made while the sandbox was running.
            "difference": compare_manifests(expected[key], entry["files"]),
        }
    return build_receipt(
        benchmark_id, sandbox_contract, image_id, observed["observation"], manifests
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--benchmark", required=True, choices=sorted(SANDBOX_CONTRACTS),
        help="benchmark id the image is being probed for",
    )
    parser.add_argument(
        "--image-id", help="immutable `im-...` id of the built image; required unless --manifest-only"
    )
    parser.add_argument(
        "--sandbox-contract", type=int,
        help="the sandbox_contract value in this benchmark's catalog row; required unless --manifest-only",
    )
    parser.add_argument("--timeout", type=int, default=300, help="sandbox timeout in seconds")
    parser.add_argument(
        "--receipt", type=Path, help="write the receipt here; refuses to overwrite an existing file"
    )
    parser.add_argument(
        "--manifest-only", action="store_true",
        help="print the accepted source manifests and exit; reads local files only",
    )
    arguments = parser.parse_args(argv)

    try:
        if arguments.manifest_only:
            payload = {
                key: {"module": module, "files": source_manifest(local)}
                for key, module, local, _root in expected_trees(arguments.benchmark)
            }
            print(json.dumps(payload, indent=2, sort_keys=True))
            return 0

        missing = [
            name
            for name, value in (
                ("--image-id", arguments.image_id),
                ("--sandbox-contract", arguments.sandbox_contract),
            )
            if value is None
        ]
        if missing:
            parser.error("{} required unless --manifest-only".format(" and ".join(missing)))

        # Before the sandbox, so an occupied path costs nothing.
        reserve_receipt(arguments.receipt)
        receipt = probe_image(
            arguments.benchmark, arguments.image_id, arguments.sandbox_contract, arguments.timeout
        )
        # Inside the handler: a path that became occupied while the sandbox ran
        # is a refusal like any other, not a traceback. The colliding file is
        # left exactly as it is, and no success line is printed for a receipt
        # that was not saved.
        if arguments.receipt:
            write_receipt(arguments.receipt, receipt)
    except ProbeError as error:
        print("probe refused: {}".format(error), file=sys.stderr)
        return 1

    if arguments.receipt:
        print("receipt written to {}".format(arguments.receipt))
    else:
        print(json.dumps(receipt, indent=2, sort_keys=True))
    print(
        "{} on {}: contract {}, python {}, sdk {}".format(
            receipt["benchmarkId"], receipt["imageId"],
            receipt["observation"]["sandboxContract"],
            receipt["observation"]["pythonVersion"],
            receipt["observation"]["sdkVersion"],
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
