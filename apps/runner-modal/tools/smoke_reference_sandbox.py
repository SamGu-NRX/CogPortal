"""Score a private reference submission on one exact published image, offline.

    python apps/runner-modal/tools/smoke_reference_sandbox.py \\
        --benchmark language-search \\
        --image-id im-XXXXXXXXXXXXXXXXXXXXXX \\
        --catalog-row build/language-search-row.json \\
        --sdk-commit 064400e \\
        --result build/language-search-smoke.json

The references in `examples/` are deliberately unpublished, so the tarball
fetch `smoke_modal.py` relies on cannot reach them, and pointing that tool at a
team's repository would score real student code. This uploads the reference
through Modal's filesystem API instead. Those writes travel over Modal's
control plane, not the sandbox's network, so every sandbox here is created
with `block_network=True` and never has outbound access.

In order:

1. Local refusals, before anything is billed. The catalog row (read from D1 by
   the operator, never from the image) must agree with the plugin in this
   checkout; the SDK tree must equal `--sdk-commit`'s; the runner, SDK,
   benchmark and reference paths must be clean; the controller's imports must
   resolve inside this checkout; and the job must clear the runner's own
   `validate_job`.
2. A staging sandbox from the exact `im-...` id. Before any reference byte
   arrives, it runs the release probe from `probe_prepared_environment.py`,
   so every Python module in the image's SDK, runner and benchmark packages is
   compared with this checkout (data files such as manifests are not), and
   checks that an outbound connection fails.
3. The reference goes in as a tarball and the runner's own `PREPARE_SCRIPT`
   unpacks and resolves it from a `file://` URL. The filesystem is then
   snapshotted.
4. `modal_app._evaluate_week3` or `_evaluate_week1`, unmodified, against that
   snapshot. It creates the evaluation sandbox, stages the gold-free payload,
   runs `EVALUATE_SCRIPT` under 3.8 and terminates the sandbox.
5. The controller's own `check_predictions` and `_v2_metrics`, run here with
   this checkout's plugin, which step 2 showed is the image's.

A pass shows that this image evaluates and scores the reference without
network access. It does not cover the portal's queue, sign-in, signed callback
or run page, the repository fetch, or the PyPI access a real prepare step has.
Without that access a packaged reference resolves through its root adapter
file rather than `pip install`, and the result records which. It also does not
show which controller is deployed: the controller here is this checkout, and
the deployed app version is a separate record.

Exit status 0 means passed. A result file is written whenever the remote part
started, pass or fail, and is never overwritten.
"""

from __future__ import annotations

import argparse
import contextlib
import gzip
import hashlib
import importlib
import io
import json
import math
import subprocess
import sys
import tarfile
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Sequence
from unittest import mock

TOOLS = Path(__file__).resolve().parent
REPO_ROOT = TOOLS.parents[2]
sys.path.insert(0, str(TOOLS))
# The benchmark packages from this checkout's submodules, not an installed copy.
for _week in ("week1", "week3"):
    sys.path.insert(0, str(REPO_ROOT / "benchmarks" / _week))

import probe_prepared_environment as probe  # noqa: E402  (also puts src and the SDK on sys.path)
from cogbench.environment import PY38_VENV  # noqa: E402
from cogbench.plugins import load_benchmark  # noqa: E402
from cogworks_runner.protocol import ProtocolError, validate_job  # noqa: E402

#: Modal app the sandboxes attach to. Deliberately not `modal_app.app`: running
#: that one would build every image it defines from this checkout.
SMOKE_APP = "cogworks-reference-smoke"

#: How long the snapshot holding the reference outlives the run. It only has to
#: last until the evaluation sandbox starts, and it contains a solution students
#: must not see, so it should not sit in the workspace for Modal's 30-day default.
SNAPSHOT_TTL_SECONDS = 3600

ARCHIVE_REMOTE_PATH = "/tmp/cog-reference.tar.gz"
PREPARE_REMOTE_PATH = "/tmp/cog-prepare.py"

#: Exits 0 only if the connection succeeds. Run under the student interpreter,
#: which is what the evaluation uses.
NETWORK_CHECK = (
    "import socket; socket.create_connection(('1.1.1.1', 443), timeout=5).close()"
)


class Track(NamedTuple):
    submodule: str
    package: str
    reference: str
    evaluator: str


#: The two tracks whose reference is current and whose student code runs in the
#: image's 3.8 venv. Vision's reference is marked DEPRECATED.md.
TRACKS = {
    "language-search": Track(
        "benchmarks/week3", "language_search_benchmark",
        "examples/week3-language-submission", "_evaluate_week3",
    ),
    "audio-identification": Track(
        "benchmarks/week1", "audio_identification_benchmark",
        "examples/week1-audio-submission", "_evaluate_week1",
    ),
}

#: Columns of the `benchmarks` row this reads, by their D1 names.
CATALOG_COLUMNS = (
    "id", "version", "contract_version", "plugin_version", "scorer_version", "sandbox_contract",
)


class SmokeError(RuntimeError):
    """A refusal or failure, with the step it happened in."""

    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage


# ---------------------------------------------------------------------------
# Local checks. No Modal, no network.
# ---------------------------------------------------------------------------


def read_catalog_row(raw: Any, benchmark_id: str) -> Dict[str, Any]:
    """One `benchmarks` row as D1 returns it, refused unless it is for this benchmark.

    A whole `SELECT *` row is accepted; only the named columns are read.
    """

    if not isinstance(raw, dict):
        raise SmokeError("local", "The catalog row must be one JSON object, as D1 returns a row.")
    missing = [column for column in CATALOG_COLUMNS if column not in raw]
    if missing:
        raise SmokeError("local", "The catalog row has no {} column.".format(", ".join(missing)))
    if raw["id"] != benchmark_id:
        raise SmokeError(
            "local", "The catalog row is for {}, not {}.".format(raw["id"], benchmark_id)
        )
    contract = raw["sandbox_contract"]
    if type(contract) is not int or contract < 1:
        raise SmokeError(
            "local", "The catalog row's sandbox_contract is {!r}; a run cannot be dispatched "
            "against it.".format(contract),
        )
    return {column: raw[column] for column in CATALOG_COLUMNS}


def check_plugin(row: Dict[str, Any], plugin: Any) -> None:
    """The catalog and this checkout's plugin must state the same versions.

    `_load_benchmark` makes the same comparison inside a run, but against a job
    built from the row, so a disagreement surfaces there as a contract failure
    after a sandbox has run. Here it costs nothing.
    """

    pairs = (
        ("version", "benchmark_version"),
        ("contract_version", "contract_version"),
        ("plugin_version", "plugin_version"),
        ("scorer_version", "scorer_version"),
    )
    differing = [
        "{} is {!r} in the catalog and {!r} in the plugin".format(
            column, row[column], getattr(plugin, attribute, None)
        )
        for column, attribute in pairs
        if row[column] != getattr(plugin, attribute, None)
    ]
    if differing:
        raise SmokeError("local", "; ".join(differing) + ".")


def build_job(row: Dict[str, Any], image_id: str, head: str, track: Track) -> Dict[str, Any]:
    """A practice job shaped like `buildRunJob`'s, cleared by the runner's validator.

    The source block describes what was uploaded. Its archive URL is never
    fetched; it exists because `validate_job` requires the GitHub form.
    """

    name = "reference/" + Path(track.reference).name
    job = {
        "protocolVersion": "1",
        "jobId": "job_reference_smoke",
        "runId": "run_reference_smoke",
        "mode": "practice",
        "preparedArtifactId": None,
        "source": {
            "repositoryId": None,
            "fullName": name,
            "sha": head,
            "archiveUrl": "https://api.github.com/repos/{}/tarball/{}".format(name, head),
        },
        "benchmark": {
            "id": row["id"],
            "version": row["version"],
            "contractVersion": row["contract_version"],
            "pluginVersion": row["plugin_version"],
            "datasetVersion": "practice-v1",
            "scorerVersion": row["scorer_version"],
            "sandboxContract": row["sandbox_contract"],
        },
        # apps/portal/worker/execution/runner.ts, for both 3.8 tracks.
        "runtime": {
            "pythonVersion": "3.8",
            "imageDigest": image_id,
            "cpu": 1,
            "memoryMb": 4096,
            "timeoutSeconds": 900,
            "maxOutputBytes": 8 * 1024,
        },
        "callback": {"url": "https://example.invalid/never-called", "keyId": "runner-v1"},
        "weights": [],
    }
    try:
        return validate_job(job)
    except ProtocolError as error:
        raise SmokeError("local", "The runner refuses this job: {}".format(error)) from None


def _git(*args: str) -> str:
    try:
        return subprocess.run(
            ["git", "-C", str(REPO_ROOT)] + list(args),
            check=True, capture_output=True, text=True,
        ).stdout.strip()
    except subprocess.CalledProcessError as error:
        raise SmokeError(
            "local", "git {} failed: {}".format(" ".join(args), error.stderr.strip()[:200])
        ) from None


def source_identity(
    track: Track, sdk_commit: str, git: Callable[..., str] = _git
) -> Dict[str, Any]:
    """Which commit the image is being compared with, and that the tree is that commit.

    The release probe compares the image with files on disk. That says which
    commit the image holds only if those files are the commit's, so uncommitted
    or untracked changes under any compared path are refused.
    """

    paths = ["python/cogbench/src", "apps/runner-modal/src", track.submodule, track.reference]
    dirty = git("status", "--porcelain", "--untracked-files=all", "--", *paths)
    if dirty:
        raise SmokeError(
            "local", "These paths differ from HEAD, so the image would be compared with "
            "files no commit holds:\n{}".format(dirty[:600]),
        )
    sdk_tree = git("rev-parse", "HEAD:python/cogbench/src")
    pinned_tree = git("rev-parse", "{}:python/cogbench/src".format(sdk_commit))
    if sdk_tree != pinned_tree:
        raise SmokeError(
            "local", "python/cogbench/src at HEAD is not the tree at {}, so a match would "
            "not be evidence about that SDK.".format(sdk_commit),
        )
    return {
        "head": git("rev-parse", "HEAD"),
        "sdkCommit": git("rev-parse", sdk_commit),
        "sdkTree": sdk_tree,
        "runnerTree": git("rev-parse", "HEAD:apps/runner-modal/src"),
        "benchmarkCommit": git("rev-parse", "HEAD:" + track.submodule),
        "referenceTree": git("rev-parse", "HEAD:" + track.reference),
    }


def check_import_roots(modules: Dict[str, Any], root: Path = REPO_ROOT) -> Dict[str, str]:
    """Refuse a controller import that resolved outside this checkout.

    The scorer and the payload encoders run here, not in the image. An
    editable install from another checkout earlier on sys.path would score
    with code the image comparison never saw.
    """

    origins = {}
    for name, module in modules.items():
        location = Path(getattr(module, "__file__", "") or "").resolve()
        if root.resolve() not in location.parents:
            raise SmokeError(
                "local", "{} was imported from {}, outside {}. Use an environment without "
                "another checkout installed.".format(name, location, root),
            )
        origins[name] = location.relative_to(root.resolve()).as_posix()
    return origins


def reference_files(track: Track, git: Callable[..., str] = _git) -> List[str]:
    """The reference's tracked files, relative to its directory.

    Tracked only: a local virtualenv, cache or egg-info is not part of the
    reference and should not be scored as if it were.
    """

    listed = git("ls-files", "--", track.reference).splitlines()
    prefix = track.reference.rstrip("/") + "/"
    files = sorted(path[len(prefix):] for path in listed if path.startswith(prefix))
    if not files:
        raise SmokeError("local", "{} has no tracked files.".format(track.reference))
    return files


def reference_archive(directory: Path, files: Sequence[str], top: str) -> bytes:
    """A gzip tarball with one top directory, as a GitHub tarball has.

    Byte-identical for identical files, so its digest identifies the upload.
    `PREPARE_SCRIPT` refuses anything but regular files and directories, and
    only regular files are added here.
    """

    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as bundle:
            folder = tarfile.TarInfo(top)
            folder.type = tarfile.DIRTYPE
            folder.mode = 0o755
            bundle.addfile(folder)
            for relative in files:
                source = directory / relative
                if source.is_symlink() or not source.is_file():
                    raise SmokeError(
                        "local", "{} is not a regular file; the runner would refuse the "
                        "archive.".format(relative),
                    )
                payload = source.read_bytes()
                entry = tarfile.TarInfo("{}/{}".format(top, relative))
                entry.size = len(payload)
                entry.mode = 0o644
                bundle.addfile(entry, io.BytesIO(payload))
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# Remote. `modal` and `runner` are passed in so tests can stand in for both.
# ---------------------------------------------------------------------------


class Plan(NamedTuple):
    benchmark_id: str
    image_id: str
    sandbox_contract: int
    job: Dict[str, Any]
    expected_manifests: Dict[str, Any]
    archive: bytes
    cases: Any
    evaluator: str
    evaluator_input: Any


class Guards:
    """Stand-ins for `Sandbox.create` and `Image.from_name` during the remote part.

    Installed over Modal's own, so they also govern the sandbox the runner's
    evaluator creates. A refusal happens before Modal is asked. Refusals are
    kept as well as raised, because the evaluator turns any exception into
    "Evaluation provider failed." and the reason would otherwise be lost.
    """

    def __init__(self, real_create: Callable[..., Any]) -> None:
        self.real_create = real_create
        self.created: List[Any] = []
        self.refusals: List[SmokeError] = []

    def _refuse(self, stage: str, message: str) -> None:
        error = SmokeError(stage, message)
        self.refusals.append(error)
        raise error

    def create(self, *args: Any, **kwargs: Any) -> Any:
        if kwargs.get("block_network") is not True or any(
            kwargs.get(name) for name in (
                "outbound_domain_allowlist", "outbound_cidr_allowlist", "cidr_allowlist",
            )
        ):
            self._refuse(
                "network", "A sandbox was about to be created with network access; nothing "
                "here needs it.",
            )
        sandbox = self.real_create(*args, **kwargs)
        self.created.append(sandbox)
        return sandbox

    def from_name(self, *_args: Any, **_kwargs: Any) -> Any:
        self._refuse(
            "provenance", "A published image name was about to be resolved. This smoke runs "
            "against the exact id it was given.",
        )


def _stderr(process: Any) -> str:
    raw = process.stderr.read()
    return raw.decode("utf-8", "replace") if isinstance(raw, bytes) else (raw or "")


def run_remote(plan: Plan, modal: Any, runner: Any, say: Callable[[str], None]) -> Dict[str, Any]:
    """Everything that touches Modal. Returns the evidence; raises on any failure.

    Owned sandboxes are terminated in `finally` whatever happens, including the
    evaluation sandbox, which the runner also terminates.
    """

    guards = Guards(modal.Sandbox.create)
    evidence: Dict[str, Any] = {"sandboxes": [], "snapshotTtlSeconds": SNAPSHOT_TTL_SECONDS}
    interpreter = probe.student_python(plan.benchmark_id, PY38_VENV)
    app = modal.App(SMOKE_APP)
    with contextlib.ExitStack() as stack:
        stack.enter_context(modal.enable_output())
        stack.enter_context(modal.runner.run_app(app))
        stack.enter_context(mock.patch.object(modal.Sandbox, "create", guards.create))
        stack.enter_context(mock.patch.object(modal.Image, "from_name", guards.from_name))
        stack.enter_context(mock.patch.object(runner, "app", app))
        try:
            say("staging sandbox from {}".format(plan.image_id))
            staging = modal.Sandbox.create(
                image=modal.Image.from_id(plan.image_id),
                app=app,
                cpu=(0.5, plan.job["runtime"]["cpu"]),
                memory=(512, plan.job["runtime"]["memoryMb"]),
                timeout=plan.job["runtime"]["timeoutSeconds"],
                block_network=True,
            )

            say("checking the image against this checkout")
            try:
                observed = probe.observe_sandbox(staging, plan.benchmark_id, plan.image_id)
                receipt = probe.receipt_from(
                    plan.benchmark_id, plan.sandbox_contract, plan.image_id,
                    plan.expected_manifests, observed,
                )
            except probe.ProbeError as error:
                raise SmokeError("provenance", str(error)) from None
            evidence["image"] = {
                "imageId": receipt["imageId"],
                "observation": {
                    key: value for key, value in receipt["observation"].items() if key != "modules"
                },
                "importedModuleRoots": receipt["importedModuleRoots"],
                "manifestRoots": {
                    key: entry["root"] for key, entry in receipt["sourceManifests"].items()
                },
                "manifestFiles": {
                    key: len(entry["files"]) for key, entry in receipt["sourceManifests"].items()
                },
            }

            say("checking the sandbox has no network")
            reach = staging.exec(interpreter, "-c", NETWORK_CHECK)
            reach.wait()
            if reach.returncode == 0:
                raise SmokeError("network", "The staging sandbox opened an outbound connection.")
            evidence["outboundConnection"] = "failed: {}".format(
                runner._last_error_line(_stderr(reach)) or "exit {}".format(reach.returncode)
            )

            say("uploading the reference and running the runner's prepare script")
            staging.filesystem.write_bytes(plan.archive, ARCHIVE_REMOTE_PATH)
            staging.filesystem.write_text(runner.PREPARE_SCRIPT, PREPARE_REMOTE_PATH)
            started = time.time()
            prepare = staging.exec(
                interpreter, PREPARE_REMOTE_PATH, "file://" + ARCHIVE_REMOTE_PATH,
                plan.benchmark_id, plan.job["benchmark"]["contractVersion"], "[]",
                text=False,
            )
            prepare.wait()
            evidence["prepareSeconds"] = round(time.time() - started, 1)
            if prepare.returncode != 0:
                raise SmokeError(
                    "prepare", "The prepare script refused the reference: {}".format(
                        runner._last_error_line(_stderr(prepare))
                    ),
                )
            evidence["resolvedBy"] = staging.filesystem.read_text("/tmp/adapter-source.txt").strip()
            snapshot_id = staging.snapshot_filesystem(ttl=SNAPSHOT_TTL_SECONDS).object_id
            evidence["snapshotImageId"] = snapshot_id
            staging.terminate()

            say("evaluating with {}".format(plan.evaluator))
            started = time.time()
            try:
                predictions, log = getattr(runner, plan.evaluator)(
                    plan.job, snapshot_id, plan.evaluator_input
                )
            except runner.RunnerFailure:
                if guards.refusals:
                    raise guards.refusals[0] from None
                raise
            evidence["evaluateSeconds"] = round(time.time() - started, 1)
            return {"evidence": evidence, "predictions": predictions, "log": log}
        finally:
            for sandbox in guards.created:
                evidence["sandboxes"].append(getattr(sandbox, "object_id", None))
                try:
                    sandbox.terminate()
                except Exception as error:  # noqa: BLE001 - report, keep cleaning up
                    say("could not terminate {}: {}".format(
                        getattr(sandbox, "object_id", "a sandbox"), error))


def score(runner: Any, benchmark: Any, cases: List[Any], predictions: List[Any]) -> Dict[str, Any]:
    """The controller's checks and scoring, as `_run_claimed` performs them."""

    runner.check_predictions(benchmark, predictions, len(cases))
    metrics, diagnostics = runner._v2_metrics(benchmark, predictions, cases)
    wire = [metric.to_wire() for metric in metrics]
    if not wire:
        raise SmokeError("score", "The scorer returned no metrics.")
    unusable = [row["key"] for row in wire if not math.isfinite(row["value"])]
    if unusable:
        raise SmokeError("score", "Not finite: {}.".format(", ".join(unusable)))
    # A complete reference measures everything, so its primary is the plugin's
    # declared one. Week 3 swaps in `text_mrr` and withholds the image-side
    # metrics when the image side never ran; finite numbers alone would let
    # that half-measured run pass.
    declared = benchmark.primary_metric
    primary = [row["key"] for row in wire if row.get("primary")]
    if primary != [declared]:
        raise SmokeError(
            "score", "The primary metric is {}, not the declared {}, so part of the "
            "reference was not measured.".format(", ".join(primary) or "missing", declared),
        )
    outcome = {
        "caseCount": len(cases),
        "metrics": wire,
        "diagnostics": [
            line for item in diagnostics[:32] for line in runner._diagnostic_lines(item)
        ][:32],
        "outputDigest": hashlib.sha256(
            json.dumps(predictions, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
    }
    sweep = runner._sweep_wire(benchmark)
    if sweep:
        outcome["sweep"] = sweep
    if runner._WIRING:
        outcome["wiring"] = list(runner._WIRING)
    return outcome


# ---------------------------------------------------------------------------
# Command line.
# ---------------------------------------------------------------------------


def _load_runner() -> Any:
    """`modal_app`, imported only once the cheap refusals have passed: it needs modal."""

    from cogworks_runner import modal_app  # noqa: PLC0415

    return modal_app


def prepare_plan(arguments: argparse.Namespace, say: Callable[[str], None]) -> Dict[str, Any]:
    """Every local step, in an order where each refusal precedes anything costlier."""

    track = TRACKS[arguments.benchmark]
    try:
        raw = json.loads(arguments.catalog_row.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SmokeError("local", "Could not read {}: {}".format(arguments.catalog_row, error)) from None
    row = read_catalog_row(raw, arguments.benchmark)
    try:
        probe.validate_probe_inputs(arguments.benchmark, arguments.image_id, row["sandbox_contract"])
    except probe.ProbeError as error:
        raise SmokeError("local", str(error)) from None
    identity = source_identity(track, arguments.sdk_commit)
    check_plugin(row, load_benchmark(arguments.benchmark))
    job = build_job(row, arguments.image_id, identity["head"], track)

    try:
        runner = _load_runner()
    except ImportError as error:
        raise SmokeError(
            "local", "modal_app could not be imported ({}). Run this from .venv-deploy, "
            "which has modal and fastapi.".format(error),
        ) from None
    benchmark = runner._load_benchmark(job)
    identity["controllerImports"] = check_import_roots({
        name: importlib.import_module(name)
        for name in ("cogbench", "cogworks_runner", track.package)
    })

    files = reference_files(track)
    archive = reference_archive(REPO_ROOT / track.reference, files, Path(track.reference).name)
    expected = probe.expected_manifests(arguments.benchmark)

    # Last, because Week 3 may download course data and Week 1 renders its
    # whole corpus. Both happen in the deployed controller before evaluation
    # too, and a failure here is the controller's, not the sandbox's.
    say("building the practice cases")
    if arguments.benchmark == "audio-identification":
        manifest = runner._week1_manifest(job)
        cases = runner._week1_cases(job, manifest)
        evaluator_input = manifest
    else:
        cases = runner._week3_cases(job, benchmark)
        evaluator_input = cases
    return {
        "plan": Plan(
            arguments.benchmark, arguments.image_id, row["sandbox_contract"], job,
            expected, archive, cases, track.evaluator, evaluator_input,
        ),
        "runner": runner,
        "benchmark": benchmark,
        "record": {
            "catalogRow": row,
            "source": identity,
            "reference": {
                "path": track.reference,
                "files": len(files),
                "archiveSha256": hashlib.sha256(archive).hexdigest(),
            },
            "job": {"benchmark": job["benchmark"], "runtime": job["runtime"], "mode": job["mode"]},
        },
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--benchmark", required=True, choices=sorted(TRACKS))
    parser.add_argument("--image-id", required=True, help="immutable `im-...` id from a probe receipt")
    parser.add_argument(
        "--catalog-row", required=True, type=Path,
        help="JSON file holding this benchmark's row from the target D1 `benchmarks` table",
    )
    parser.add_argument(
        "--sdk-commit", required=True,
        help="commit whose python/cogbench/src the image is expected to hold",
    )
    parser.add_argument("--result", required=True, type=Path, help="never overwritten")
    arguments = parser.parse_args(argv)

    def say(line: str) -> None:
        print(line, flush=True)

    record: Dict[str, Any] = {
        "schemaVersion": 1,
        "tool": "smoke_reference_sandbox.py",
        "benchmarkId": arguments.benchmark,
        "imageId": arguments.image_id,
        "scope": (
            "Sandbox evaluation of an uploaded reference on this exact image, with network "
            "blocked in every sandbox. Not the portal's queue, sign-in, callback or run page, "
            "not the repository fetch, and not the deployed controller's identity."
        ),
    }
    try:
        probe.reserve_receipt(arguments.result)
        prepared = prepare_plan(arguments, say)
    except (SmokeError, probe.ProbeError) as error:
        print("smoke refused: {}".format(error), file=sys.stderr)
        return 1
    record.update(prepared["record"])
    runner = prepared["runner"]

    import modal  # noqa: PLC0415
    import modal.runner  # noqa: PLC0415, F401

    record["modalClient"] = modal.__version__
    plan = prepared["plan"]
    status = 1
    try:
        remote = run_remote(plan, modal, runner, say)
        record["execution"] = remote["evidence"]
        record["outcome"] = score(runner, prepared["benchmark"], plan.cases, remote["predictions"])
        record["studentLogHead"] = remote["log"][:2000]
        record["status"] = "passed"
        status = 0
    except SmokeError as error:
        record["status"] = "failed"
        record["failure"] = {"stage": error.stage, "detail": str(error)[:1000]}
    except runner.RunnerFailure as failure:
        # The same four fields a failed run carries to the portal.
        record["status"] = "failed"
        record["failure"] = {
            "stage": failure.phase,
            "category": failure.category,
            "infrastructure": failure.infrastructure,
            "detail": str(failure)[:1000],
        }
    except Exception as error:  # noqa: BLE001 - a result file is still owed
        traceback.print_exc()
        record["status"] = "failed"
        record["failure"] = {
            "stage": "unexpected",
            "detail": "{}: {}".format(type(error).__name__, str(error)[:1000]),
        }

    try:
        probe.write_receipt(arguments.result, record)
    except probe.ProbeError as error:
        print("result not saved: {}".format(error), file=sys.stderr)
        print(json.dumps(record, indent=2, sort_keys=True))
        return 1
    if status == 0:
        say("PASSED, result in {}".format(arguments.result))
        for metric in record["outcome"]["metrics"]:
            say("  {:<28} {:.4f}{}".format(
                metric["key"], metric["value"], "  (primary)" if metric.get("primary") else ""))
    else:
        say("FAILED at {}: {}".format(record["failure"]["stage"], record["failure"]["detail"]))
        say("result in {}".format(arguments.result))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
