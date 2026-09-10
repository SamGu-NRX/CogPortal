"""Run one benchmark end to end on Modal, against a real repository.

This is the only evidence that the hosted path works. Unit tests cover the
payload encoders and the failure taxonomy, but nothing else exercises the two
sandboxes, the filesystem snapshot between them, the network block, or the
3.8 venv -- and every one of those has failed at least once in a way no test
caught.

    python apps/runner-modal/tools/smoke_modal.py \\
        --benchmark audio-identification \\
        --repo KrazeeCoder/week1-capstone-team4

It calls the same `_prepare` / `_evaluate_*` functions the job runner calls,
so a pass here means the deployed path works, not that a parallel copy of it
does. It does not post events to a portal: the run job it builds carries a
callback URL that is never used, because `execute_job` is not what runs.

Exit code 0 means prepared, evaluated, and scored. Anything else prints the
phase and the failure category the portal would have recorded.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
# The controller half of a run -- manifest loading and scoring -- imports the
# benchmark plugin. On Modal that comes from `controller_image`; here it has to
# come from the working tree, so a smoke run does not require the plugins to be
# pip-installed into this venv first.
sys.path.insert(0, str(REPO / "python" / "cogbench" / "src"))
sys.path.insert(0, str(REPO / "benchmarks" / "week1"))
sys.path.insert(0, str(REPO / "benchmarks" / "week3"))

import modal  # noqa: E402
import modal.runner  # noqa: E402

from cogworks_runner import modal_app  # noqa: E402
from cogworks_runner.protocol import validate_job  # noqa: E402

#: Benchmarks this can drive, and the evaluate function each one needs. Week 2
#: is absent because its payload needs a CelebA manifest this does not build.
EVALUATORS = {
    "audio-identification": "week1",
    "language-search": "week3",
}


def _benchmark_block(benchmark_id: str, mode: str) -> dict:
    """Version fields read off the installed plugin.

    `_load_benchmark` refuses the job when these disagree with the plugin's own
    attributes. That check is what catches a stale image, so the smoke test
    satisfies it by reading the truth rather than by hardcoding values that
    would make the check vacuous.
    """

    from cogbench.plugins import load_benchmark

    plugin = load_benchmark(benchmark_id)
    return {
        "id": benchmark_id,
        "version": plugin.benchmark_version,
        "contractVersion": plugin.contract_version,
        "pluginVersion": plugin.plugin_version,
        "datasetVersion": plugin.dataset_version if mode == "official" else "practice-v1",
        "scorerVersion": plugin.scorer_version,
    }


def build_job(benchmark_id: str, repo: str, sha: str, mode: str) -> dict:
    """A protocol-valid run job. The runtime block mirrors `buildRunJob`."""

    heavy = benchmark_id in ("language-search", "audio-identification")
    return {
        "protocolVersion": "1",
        "jobId": "job_smoke_{}".format(int(time.time())),
        "runId": "run_smoke_{}".format(int(time.time())),
        "mode": mode,
        "preparedArtifactId": None,
        "source": {
            "repositoryId": 0,
            "fullName": repo,
            "sha": sha,
            "archiveUrl": "https://api.github.com/repos/{}/tarball/{}".format(repo, sha),
        },
        # Read off the installed plugin rather than hardcoded: `_load_benchmark`
        # refuses to run when the job's declared versions disagree with the
        # plugin's, which is the check that catches a stale image, so the smoke
        # test has to satisfy it honestly rather than route around it.
        "benchmark": _benchmark_block(benchmark_id, mode),
        "runtime": {
            "pythonVersion": "3.8" if heavy else "3.11",
            "imageDigest": "smoke",
            "cpu": 1,
            "memoryMb": 4096 if heavy else 2048,
            "timeoutSeconds": 900,
            "maxOutputBytes": 8 * 1024,
        },
        "callback": {"url": "https://example.invalid/never-called", "keyId": "runner-v1"},
        # Required whenever preparedArtifactId is None, which it always is
        # here. The empty list is the honest value: no trained weights, rather
        # than no weights field.
        "weights": [],
    }


class PrintReporter:
    """`LiveReporter`'s interface, printing instead of posting."""

    def event(self, event_type: str, **fields: object) -> None:
        print("  event {} {}".format(event_type, json.dumps(fields)[:200]), flush=True)

    def status(self, phase: str, current: object = None, total: object = None) -> None:
        # StatusHeartbeat calls this positionally with (phase, current, total).
        suffix = "" if current is None else " {}/{}".format(current, total)
        print("  status {}{}".format(phase, suffix), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--benchmark", required=True, choices=sorted(EVALUATORS))
    parser.add_argument("--repo", required=True, help="owner/name of a public repository")
    parser.add_argument("--sha", help="commit to score; defaults to the default branch head")
    parser.add_argument("--mode", default="practice", choices=("practice", "official"))
    parser.add_argument("--keep-going", action="store_true",
                        help="report the failure and exit 0; for sweeping many repositories")
    args = parser.parse_args()

    # An official job has to name a prepared artifact, and this tool always
    # prepares a fresh one, so it has none to name. Official scoring also reads
    # the hidden dataset volume, which a smoke run has no business touching.
    # The choice stays listed so this says why, rather than argparse rejecting
    # it without a reason.
    if args.mode == "official":
        parser.error(
            "official mode needs a prepared artifact this tool cannot supply; "
            "smoke runs are practice only"
        )

    sha = args.sha
    if not sha:
        import urllib.request
        url = "https://api.github.com/repos/{}/commits?per_page=1".format(args.repo)
        request = urllib.request.Request(url, headers={"User-Agent": "cogworks-smoke"})
        with urllib.request.urlopen(request, timeout=30) as response:
            sha = json.load(response)[0]["sha"]
        print("resolved {} -> {}".format(args.repo, sha[:12]), flush=True)

    # `submit_job` validates before it spawns anything, so a job this tool
    # builds by hand has to clear the same gate or the tool is exercising a
    # shape the endpoint would have refused. Skipping it is how a missing
    # `weights` key reached `_prepare` and surfaced as a provider fault
    # instead of the protocol error that names the field.
    job = validate_job(build_job(args.benchmark, args.repo, sha, args.mode))
    reporter = PrintReporter()
    started = time.time()

    # `_prepare` and `_evaluate_*` create sandboxes against `modal_app.app`,
    # which has to be running for `Sandbox.create(app=...)` to attach.
    with modal.enable_output(), modal.runner.run_app(modal_app.app):
        try:
            print("prepare...", flush=True)
            snapshot = modal_app._prepare(job, reporter)
            print("  snapshot {}".format(snapshot), flush=True)

            print("evaluate...", flush=True)
            if EVALUATORS[args.benchmark] == "week1":
                manifest = modal_app._week1_manifest(job)
                cases = modal_app._week1_cases(job, manifest)
                predictions, log = modal_app._evaluate_week1(job, snapshot, manifest)
            else:
                benchmark = modal_app._load_benchmark(job)
                cases = modal_app._week3_cases(job, benchmark)
                predictions, log = modal_app._evaluate_week3(job, snapshot, cases)

            print("  {} predictions for {} cases".format(len(predictions), len(cases)), flush=True)

            print("score...", flush=True)
            benchmark = modal_app._load_benchmark(job)
            metrics, diagnostics = modal_app._v2_metrics(benchmark, predictions, cases)
        except modal_app.RunnerFailure as failure:
            print("\nFAILED after {:.0f}s".format(time.time() - started))
            print("  phase       {}".format(failure.phase))
            print("  category    {}".format(failure.category))
            print("  infra       {}".format(failure.infrastructure))
            print("  detail      {}".format(str(failure)[:600]))
            return 0 if args.keep_going else 1

    print("\nPASSED in {:.0f}s".format(time.time() - started))
    for metric in metrics:
        print("  {:<28} {:.4f}{}".format(
            metric.key, metric.value, "  (primary)" if metric.primary else ""))
    for line in diagnostics:
        print("  note: {}".format(line))
    if log.strip():
        print("\n--- student log (first 1200 chars) ---")
        print(log[:1200])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
