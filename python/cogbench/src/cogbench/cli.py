from __future__ import annotations

import argparse
import json
import os
import platform
import queue
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, List, NamedTuple, Optional, Sequence, Tuple
from urllib.parse import urlparse

from . import __version__
from .environment import gap_note, local_gap
from .isolate import COMPLETED, Outcome, run_isolated, run_operation
from .client import (
    PortalError,
    device_status,
    poll_device_link,
    send_local_run_event,
    send_local_run_event_batch,
    start_device_link,
    start_local_run,
    sync_report,
    update_setup_checks,
    upload_weight,
)
from .models import LocalReport
from .resolve import from_spec, resolve
from .plugins import (
    PluginError,
    load_benchmark,
    load_submission,
    plugin_names,
    resolve_submission,
)
from .progress import TerminalProgress
from .project import repository_state
from .report import render_check
from .runner import ContractError, execute, model_cache_status
from .storage import active_portal, latest_report, save_report, save_token, token_for

PROGRAM = "cogworks"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROGRAM,
        description="Check and run CogWorks practice benchmarks locally.",
    )
    parser.add_argument("--version", action="version", version=__version__)
    # The metavar hides the deprecated `doctor` alias from the choices list;
    # `help=argparse.SUPPRESS` rendered a literal "==SUPPRESS==" row instead
    # of hiding it (argparse only honors SUPPRESS for arguments, not
    # subcommands).
    subparsers = parser.add_subparsers(
        dest="command",
        metavar="{check,test,run,report,link,sync,status}",
    )
    for name, help_text in (
        ("check", "check the local project and benchmark environment"),
        ("doctor", None),  # deprecated alias for check; hidden from help
        ("test", "check your code against one small benchmark case"),
        ("run", "run the public local practice benchmark"),
    ):
        command = subparsers.add_parser(name, **({} if help_text is None else {"help": help_text}))
        command.add_argument("--benchmark", required=True)
        command.add_argument("--json", action="store_true")
        command.add_argument(
            "--update-setup",
            action="store_true",
            help="after local success, update your linked CogPortal setup guide",
        )
        if name == "run":
            command.add_argument(
                "--live",
                action="store_true",
                help="share one live progress bubble with your linked team",
            )
            command.add_argument(
                "--portal",
                help="use this CogPortal address instead of the saved one",
            )
    report = subparsers.add_parser("report", help="show a saved local report")
    report.add_argument(
        "path",
        nargs="?",
        help="saved report file to show (uses the latest report when omitted)",
    )
    link = subparsers.add_parser("link", help="link this device to CogPortal")
    link.add_argument(
        "--portal",
        help="use this CogPortal address instead of the saved one",
    )
    link.add_argument(
        "--no-browser",
        action="store_true",
        help="print the approval link without opening your browser",
    )
    sync = subparsers.add_parser("sync", help="explicitly sync one local report")
    sync.add_argument(
        "path",
        nargs="?",
        help="saved report file to sync (uses the latest report when omitted)",
    )
    sync.add_argument(
        "--portal",
        help="use this CogPortal address instead of the saved one",
    )
    status = subparsers.add_parser("status", help="show this device's CogPortal connection")
    status.add_argument(
        "--portal",
        help="use this CogPortal address instead of the saved one",
    )
    return parser


def _portal(value: Optional[str]) -> str:
    portal = value or os.environ.get("COGPORTAL_URL") or active_portal()
    if not portal:
        raise PortalError(
            "No CogPortal is selected. Copy `cogworks link --portal ...` from the setup page."
        )
    portal = portal.rstrip("/")
    parsed = urlparse(portal)
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    valid_origin = (
        parsed.hostname
        and parsed.username is None
        and parsed.password is None
        and parsed.path in ("", "/")
        and not parsed.params
        and not parsed.query
        and not parsed.fragment
    )
    if not valid_origin or (parsed.scheme != "https" and not (local and parsed.scheme == "http")):
        raise PortalError("CogPortal must use HTTPS (HTTP is allowed only for local development).")
    return portal


def _setup_payload(
    checks: Sequence[str], project_root: Path, benchmark: Optional[str] = None
) -> dict:
    repository = repository_state(project_root)
    if not repository.full_name:
        raise PortalError(
            "This directory is not a GitHub worktree with an `origin` remote. "
            "Change into your team project and retry."
        )
    payload = {
        "schemaVersion": 1,
        "repositoryFullName": repository.full_name,
        "checks": list(dict.fromkeys(checks)),
        "cliVersion": __version__,
        "pythonVersion": platform.python_version(),
        "benchmarkIds": sorted(
            set(plugin_names("cogworks.benchmarks.v1"))
            | set(plugin_names("cogworks.benchmarks.v2"))
        ),
        "submissionIds": sorted(
            set(plugin_names("cogworks.submissions.v1"))
            | set(plugin_names("cogworks.submissions.v2"))
        ),
    }
    # Two of the four checks are about one benchmark: the install line names a
    # single distribution and wiring resolves that benchmark's entry points.
    # Without this the portal recorded them against the student and the team
    # only, and the setup page credited whichever track it happened to be
    # showing. Omitted rather than sent empty when there is no benchmark, so a
    # portal that predates the field still accepts the request.
    if benchmark:
        payload["checkedBenchmarkId"] = benchmark
    return payload


def _update_setup(
    portal_value: Optional[str],
    checks: Sequence[str],
    project_root: Path,
    benchmark: Optional[str] = None,
) -> None:
    portal = _portal(portal_value)
    token = token_for(portal)
    if not token:
        raise PortalError(
            "This CogPortal connection is missing, expired, or revoked. "
            "Run `cogworks link --portal {}` and retry.".format(portal)
        )
    result = update_setup_checks(
        portal, token, _setup_payload(checks, project_root, benchmark)
    )
    accepted = result.get("accepted")
    if not isinstance(accepted, list):
        raise PortalError("CogPortal returned an invalid setup response.")
    print("setup: updated {}".format(", ".join(str(step) for step in accepted)))


def _print_report(report: LocalReport, as_json: bool = False) -> None:
    if as_json:
        print(report.to_json())
        return
    print("{} v{} · LOCAL · SELF-REPORTED".format(report.benchmark_id, report.benchmark_version))
    for metric in report.metrics:
        precision = max(metric.precision, 4) if metric.primary else metric.precision
        value = ("{:.%df}" % precision).format(metric.value)
        unit = metric.unit
        # Older plugins omitted the unit for timing metrics. The key is the
        # only remaining evidence that the value is measured in seconds.
        if not unit and metric.key.endswith("_seconds"):
            unit = "s"
        print("{}: {}{}".format(metric.label, value, " " + unit if unit else ""))
    if report.repository.sha:
        print("commit: {}{}".format(report.repository.sha[:7], " (dirty)" if report.repository.dirty else ""))
    for diagnostic in report.diagnostics:
        print("note: {}".format(diagnostic))


def _resolve_report(path_value: Optional[str], project_root: Path) -> Path:
    if path_value:
        return Path(path_value).expanduser().resolve()
    latest = latest_report(project_root)
    if latest is None:
        raise ContractError("No local reports found. Run `cogworks run` first.")
    return latest


def _format_expiry(expires_at_ms: int, now: Optional[datetime] = None) -> str:
    expires = datetime.fromtimestamp(expires_at_ms / 1000, tz=timezone.utc)
    current = now or datetime.now(timezone.utc)
    days = (expires.date() - current.astimezone(timezone.utc).date()).days
    date = "{} {}".format(expires.strftime("%b"), expires.day)
    if days == 0:
        return "{} (today)".format(date)
    if days == 1:
        return "{} (in 1 day)".format(date)
    if days > 1:
        return "{} (in {} days)".format(date, days)
    if days == -1:
        return "{} (1 day ago)".format(date)
    return "{} ({} days ago)".format(date, abs(days))


#: The interpreter each track's student code actually runs on when hosted.
#: Not one number any more: the shared Modal image is 3.11 because the
#: 2025.06 image builder dropped 3.8, but week1 and week3 exec student code
#: through a pinned CPython 3.8.20 venv baked into that image
#: (apps/runner-modal/src/cogworks_runner/modal_app.py). Reporting the wrong
#: one sends a student chasing a version difference that isn't there.
_HOSTED_PYTHON = {"language-search": "3.8.20", "audio-identification": "3.8.20"}
_DEFAULT_HOSTED_PYTHON = "3.11"


def _hosted_python(benchmark: str) -> str:
    return _HOSTED_PYTHON.get(benchmark, _DEFAULT_HOSTED_PYTHON)


def _installed_benchmark_hint() -> str:
    """A benchmark name to show in an example command. `link` takes no
    --benchmark, so naming one track would be a guess; naming what is actually
    installed is not. With zero or several installed, stay a placeholder."""

    installed = plugin_names("cogworks.benchmarks.v2") or plugin_names(
        "cogworks.benchmarks.v1"
    )
    return installed[0] if len(installed) == 1 else "<benchmark>"


def _discover(benchmark: str, project_root: Path, as_json: bool):
    """Search the repository for the code this benchmark needs.

    Returns ``(submission, survey, unavailable)``, any of which may be None.
    ``unavailable`` is why the search could not run at all, which is not the
    same as searching and finding nothing: a benchmark that cannot describe
    its task right now sends the reader somewhere different than one whose
    repository holds nothing to bind.

    Nothing here may fail the command. Discovery imports and runs a team's own
    code, and the whole point of the report is to be readable when that code
    misbehaves.
    """

    plugin = load_benchmark(benchmark)
    describes = getattr(plugin, "discovery", None)
    if not callable(describes):
        return None, None, None

    try:
        spec = describes()
    except Exception as error:  # noqa: BLE001 - a broken benchmark is ours, not theirs
        # Measured: week 3 asks for its caption file when it builds the spec,
        # so on a machine that has not fetched the data yet this raised and
        # the report said the benchmark "does not yet describe its task",
        # which sent the student to write an adapter instead of running
        # `cogworks test`. The reason carries its own next step; print it.
        return None, None, str(error)

    watcher = None if as_json else TerminalProgress()
    try:
        submission = from_spec(
            project_root,
            spec,
            progress=watcher,
            remember=True,
            benchmark=benchmark,
        )
    except Exception as error:  # noqa: BLE001
        if watcher is not None:
            watcher.done()
        print("Could not read your repository: {}".format(error), file=sys.stderr)
        return None, None, None

    found = submission.discovery
    return submission, (found.to_dict() if found is not None else None), None


class _Scoreable(NamedTuple):
    """The one answer `check` reports and `run` acts on.

    `factory` is None exactly when there is nothing to score. Every other
    field is the evidence behind that, for the report.
    """

    factory: Optional[Callable[..., Any]]
    weights: List[str]
    #: What would actually be scored: "file", "discovery", or None.
    source: Optional[str]
    #: The live resolution, for a caller in the same process. None when
    #: discovery did not run or could not read the repository.
    submission: Optional[Any]
    survey: Optional[dict]
    #: How `resolve_submission` answered, whether or not that is what runs.
    #: An installed entry point is reported and not scored, so a student can
    #: see the reference package is on their machine without being told it is
    #: their submission.
    declared_source: Optional[str] = None
    declared_detail: Optional[str] = None
    declared_error: Optional[str] = None
    #: Why the search could not run at all, when it could not.
    discovery_unavailable: Optional[str] = None


def _scoreable(name: str, benchmark, project_root: Path, *, as_json: bool) -> _Scoreable:
    """Decide, once, what this repository would be scored on.

    `check` and `run` have to agree. A student told their code is wired up and
    ready to score, who then runs the command that report ends with and is met
    with "no submission found", has been lied to by one of the two. They used
    to answer separately: `check` accepted an installed entry point, `run`
    refused it, and a vision-recognition repository passed the check and then
    raised on the run. There is one decision now and both call it.

    A declaration always wins. Discovery is what happens when there is none,
    which for every repository in the 2026 corpus is always.
    """

    declared_source = None
    declared_detail = None
    declared_error = None
    # A file in THIS repository, never an installed entry point. An entry
    # point belongs to whatever package was pip-installed, and scoring that
    # while standing in a student's repository produces a number for somebody
    # else's code that looks exactly like a number for theirs. Measured: an
    # empty repository scored 52% against the reference submission.
    try:
        factory, declared_source, declared_detail = resolve_submission(
            name, str(benchmark.contract_version), project_root
        )
        if declared_source == "file":
            return _Scoreable(
                factory, [], "file", None, None, declared_source, declared_detail
            )
    except PluginError as error:
        declared_error = str(error)

    submission, survey, unavailable = _discover(name, project_root, as_json)
    build = getattr(benchmark, "submission_from_discovery", None)
    if submission is None or not submission.ready or not callable(build):
        return _Scoreable(
            None, [], None, submission, survey,
            declared_source, declared_detail, declared_error, unavailable,
        )
    weights = [str(path) for path in submission.weights_used]
    return _Scoreable(
        (lambda *args, **kwargs: build(submission)),
        weights,
        "discovery",
        submission,
        survey,
        declared_source,
        declared_detail,
        declared_error,
    )


def _submission_for(name: str, benchmark, project_root: Path, *, as_json: bool):
    """What to score, or a refusal. Returns the adapter and its weight paths."""

    scoreable = _scoreable(name, benchmark, project_root, as_json=as_json)
    if scoreable.factory is None:
        # The report already said why in full. Repeating it here would print
        # the same paragraphs twice, so this points at the command that
        # explains it.
        raise PluginError(
            "Nothing in this repository could be scored yet. Run "
            "`cogworks check --benchmark {}` to see what was found.".format(name)
        )
    return scoreable.factory, scoreable.weights


def _check_view(name: str, project_root: Path, as_json: bool) -> dict:
    """Read the repository and answer the readiness question, as plain data.

    This is the whole of `check` that touches student code, and it is the unit
    that runs in the child process. Everything it returns has to survive a
    pickle, so the live `Submission` is projected to its report.
    """

    benchmark = load_benchmark(name)
    scoreable = _scoreable(name, benchmark, project_root, as_json=as_json)
    return {
        "ready": scoreable.factory is not None,
        "source": scoreable.source,
        "report": None if scoreable.submission is None else scoreable.submission.report(),
        "survey": scoreable.survey,
        "declaredSource": scoreable.declared_source,
        "declaredDetail": scoreable.declared_detail,
        "declaredError": scoreable.declared_error,
        "discoveryUnavailable": scoreable.discovery_unavailable,
    }


def _read_repository(
    name: str, project_root: Path, as_json: bool, *, diagnostics: Optional[dict] = None
) -> Tuple[Optional[dict], str, str]:
    """Run `_check_view` where it cannot take this command down with it.

    A student module can end the interpreter rather than raise: one 2026
    repository's audio helper loads a second copy of a native backend and dies
    with a nanobind error no `except` clause can see (`tests/test_isolate.py`).
    Reading happened in this process, so the command whose whole job is to
    explain a repository printed nothing at all about that one.

    Returns `(view, status, detail)`. `view` is None when the child did not
    report, and the status and detail are then what there is to say.
    """

    if not hasattr(os, "fork"):
        # Windows has no fork, so there is no isolation to offer. Running it
        # here is what the platform can do; refusing instead would tell every
        # Windows student their repository could not be read, which is a
        # sentence about their code that nothing observed. `discover.survey`
        # made the same call for the same reason.
        return _check_view(name, project_root, as_json), COMPLETED, ""

    # The child runs from the repository, which is where `cogworks run`
    # imports a declared submission from. Left on the default scratch
    # directory, a `submission.py` that reads a relative file at import time
    # failed the check and then worked on the run, which is the disagreement
    # this whole path exists to remove. Discovery still imports their modules
    # from a scratch directory of its own; that is `discover`'s business.
    if sys.platform == "darwin":
        outcome = run_operation("check", {
            "name": name, "repository": str(project_root.resolve()), "as_json": as_json,
        }, scratch=project_root)
    else:
        outcome = run_isolated(
            lambda: _check_view(name, project_root, as_json), scratch=project_root
        )
    if diagnostics is not None:
        diagnostics.update(outcome.diagnostics())
    if outcome.status == COMPLETED and isinstance(outcome.value, dict):
        return outcome.value, outcome.status, outcome.detail
    return None, outcome.status, outcome.detail


def _check(benchmark: str, as_json: bool, project_root: Path) -> int:
    benchmark_group = (
        "cogworks.benchmarks.v2"
        if benchmark in plugin_names("cogworks.benchmarks.v2")
        else "cogworks.benchmarks.v1"
    )
    contract_group = (
        "cogworks.submissions.v2"
        if benchmark_group == "cogworks.benchmarks.v2"
        else "cogworks.submissions.v1"
    )
    benchmark_plugins = plugin_names(benchmark_group)
    submission_plugins = plugin_names(contract_group)
    repository = repository_state(project_root)
    checks = {
        "python": platform.python_version(),
        "canonicalHostedPython": _hosted_python(benchmark),
        "contractVersion": contract_group,
        "benchmarkInstalled": benchmark in benchmark_plugins,
        "submissionInstalled": benchmark in submission_plugins,
        "gitRepository": bool(repository.sha),
        "repositoryFullName": repository.full_name,
    }
    checks["benchmarkLoadable"] = False
    checks["submissionLoadable"] = False
    #: What would actually be scored: a file in this repository, or what
    #: discovery bound. Never an installed entry point, because `run` will not
    #: score one either, and the two commands answer from the same decision.
    checks["submissionSource"] = None
    checks["submissionDetail"] = None
    if checks["benchmarkInstalled"] and benchmark_group.endswith(".v2"):
        plugin = load_benchmark(benchmark)
        checks["benchmarkLoadable"] = True
        # Plugins may report their own model/artifact cache; Week 2 predates
        # the attribute, so its FaceNet checkpoint probe stands.
        cache_probe = getattr(plugin, "model_cache_status", None)
        checks["modelCache"] = cache_probe() if callable(cache_probe) else model_cache_status()
        for tier in ("test", "evaluation"):
            status = plugin.cache_status(tier)
            checks["data{}Cache".format(tier.title())] = {
                "ready": status.ready,
                "path": str(status.path),
                "message": status.message,
            }
    elif checks["benchmarkInstalled"]:
        load_benchmark(benchmark)
        checks["benchmarkLoadable"] = True
    # Everything that reads the repository happens in one call, in a child
    # process, and answers the same question `run` asks.
    submission = None
    survey = None
    installed_reference = False
    unread_detail = ""
    search_unavailable = ""
    if checks["benchmarkLoadable"]:
        diagnostics: dict = {}
        view, status, detail = _read_repository(
            benchmark, project_root, as_json, diagnostics=diagnostics
        )
        if view is None:
            unread_detail = detail or "the process reading it ended without saying why"
            checks["submissionError"] = (
                "Reading this repository ended the process ({}): {}".format(status, unread_detail)
            )
            checks["submissionDetail"] = diagnostics
        else:
            submission = view["report"]
            survey = view["survey"]
            checks["submissionLoadable"] = bool(view["ready"])
            checks["submissionSource"] = view["source"]
            checks["submissionDetail"] = view["declaredDetail"]
            installed_reference = view["declaredSource"] == "entry_point"
            search_unavailable = view["discoveryUnavailable"] or ""
            if view["declaredError"]:
                checks["submissionError"] = view["declaredError"]
            if submission is not None and submission.record is not None:
                checks["discovery"] = submission.record

    # Which of the graded run's packages this machine cannot import. Reported
    # whether or not discovery ran, because it explains a difference between
    # what this command sees and what the graded run sees, and that difference
    # exists either way. Recorded in the JSON as well as the text report: the
    # portal and any script reading `check --json` need the same fact.
    checks["localGap"] = list(local_gap(benchmark))

    if as_json:
        print(json.dumps(checks, indent=2, sort_keys=True, default=str))
    else:
        for line in render_check(
            benchmark=benchmark,
            python_version=checks["python"],
            hosted_python=checks["canonicalHostedPython"],
            benchmark_ready=bool(checks["benchmarkLoadable"]),
            repository=checks["repositoryFullName"],
            submission=submission,
            survey=survey,
            local_gap_note=gap_note(benchmark, checks["localGap"]),
            submission_source=checks["submissionSource"],
            installed_reference=installed_reference,
            unread_detail=unread_detail,
            search_unavailable=search_unavailable,
        ):
            print(line)
    # `submissionInstalled` is deliberately not required: it only reports the
    # entry-point registration, and a repository that resolves by file has none.
    # `submissionLoadable` is the signal that we actually found the submission.
    required = (
        "gitRepository",
        "repositoryFullName",
        "benchmarkInstalled",
        "benchmarkLoadable",
        "submissionLoadable",
    )
    return 0 if all(checks[key] for key in required) else 2


def _live_progress_payload(
    phase: str,
    current: Optional[int] = None,
    total: Optional[int] = None,
) -> dict:
    code = _LiveRun._code(phase)
    if phase == "evaluating" and current is not None and current > 0:
        code = "evaluation.progress"
    payload = {"type": "progress", "phase": phase, "code": code}
    if current is not None and total is not None:
        payload["progress"] = {"current": current, "total": total, "unit": "cases"}
    return payload


class _LiveRun:
    def __init__(self, portal: str, token: str, session_id: str) -> None:
        self.portal = portal
        self.token = token
        self.session_id = session_id
        self.sequence = 0
        self.phase = "preparing"
        self.started_at = int(time.time() * 1000)
        self.current = None
        self.total = None
        self._events = queue.Queue(maxsize=32)
        self._closed = threading.Event()
        self._warned = False
        self._lock = threading.Lock()
        self._history = []
        self._sender = threading.Thread(target=self._send_loop, name="cogworks-live-sender", daemon=True)
        self._heartbeat = threading.Thread(target=self._heartbeat_loop, name="cogworks-live-heartbeat", daemon=True)
        self._sender.start()
        self._heartbeat.start()

    def _payload(self, payload: dict) -> dict:
        with self._lock:
            sequence = self.sequence
            self.sequence += 1
        value = dict(payload)
        value.update({
            "eventId": "localevent_" + uuid.uuid4().hex,
            "sequence": sequence,
            "occurredAt": int(time.time() * 1000),
            "elapsedMs": max(0, int(time.time() * 1000) - self.started_at),
        })
        return value

    def _queue(self, payload: dict, terminal: bool = False) -> Optional[threading.Event]:
        done = threading.Event() if terminal else None
        event = self._payload(payload)
        with self._lock:
            self._history.append((event, not terminal and event.get("code") == "evaluation.progress"))
            while len(self._history) > 32:
                removable = next(
                    (index for index, (_, progress) in enumerate(self._history) if progress),
                    0,
                )
                self._history.pop(removable)
        item = (event, done)
        try:
            if terminal:
                self._events.put(item, timeout=1)
            else:
                self._events.put_nowait(item)
        except queue.Full:
            if terminal and not self._warned:
                self._warned = True
                print("cogworks: final live update could not be queued", file=sys.stderr)
        return done

    def _send_loop(self) -> None:
        while True:
            item = self._events.get()
            if item is None:
                self._events.task_done()
                return
            payload, done = item
            try:
                send_local_run_event(self.portal, self.token, self.session_id, payload)
            except PortalError as error:
                if not self._closed.is_set() and not self._warned:
                    self._warned = True
                    print("cogworks: live updates paused: {}".format(error), file=sys.stderr)
            finally:
                if done:
                    done.set()
                self._events.task_done()

    def _heartbeat_loop(self) -> None:
        while not self._closed.wait(2.0):
            self._queue(_live_progress_payload(self.phase, self.current, self.total))

    @staticmethod
    def _code(phase: str) -> str:
        return {
            "preparing": "repository.ready",
            "contract_check": "contract.checking",
            "evaluating": "evaluation.started",
            "scoring": "scoring.started",
        }.get(phase, "evaluation.progress")

    def progress(self, phase: str, current: Optional[int] = None, total: Optional[int] = None) -> None:
        if self.phase == "contract_check" and phase == "evaluating":
            self._queue({"type": "progress", "phase": "contract_check", "code": "contract.passed"})
        self.phase = phase
        self.current = current
        self.total = total
        self._queue(_live_progress_payload(phase, current, total))

    def _finish(self, payload: dict) -> None:
        deadline = time.monotonic() + 5.0
        self._closed.set()
        done = self._queue(payload, terminal=True)
        with self._lock:
            history = [event for event, _ in self._history]
        try:
            send_local_run_event_batch(self.portal, self.token, self.session_id, history)
        except (PortalError, OSError, ValueError) as error:
            if not self._warned:
                self._warned = True
                print("cogworks: final live update was delayed: {}".format(error), file=sys.stderr)
            if done:
                done.wait(max(0.0, deadline - time.monotonic()))
        try:
            self._events.put_nowait(None)
        except queue.Full:
            pass

    def completed(self, report: LocalReport) -> None:
        self._finish({"type": "completed", "report": report.to_wire()})

    def failed(self, error: Exception) -> None:
        if isinstance(error, ContractError):
            code = "run.failed.contract"
        elif isinstance(error, TimeoutError):
            code = "run.failed.timeout"
        elif isinstance(error, MemoryError):
            code = "run.failed.memory"
        else:
            code = "run.failed.runtime"
        self._finish({"type": "failed", "phase": self.phase, "code": code})


def _start_live_run(
    args: argparse.Namespace, benchmark: object, project_root: Path
) -> _LiveRun:
    portal = _portal(args.portal)
    token = token_for(portal)
    if not token:
        raise PortalError("This portal is not linked. Run `cogworks link` first.")
    repository = repository_state(project_root)
    if not repository.full_name or not repository.sha:
        raise PortalError("Live sharing requires a committed GitHub repository.")
    result = start_local_run(
        portal,
        token,
        {
            "clientRunId": "localrun_" + uuid.uuid4().hex,
            "benchmarkId": str(getattr(benchmark, "benchmark_id")),
            "benchmarkVersion": int(getattr(benchmark, "benchmark_version")),
            "repositoryId": repository.repository_id,
            "repositoryFullName": repository.full_name,
            "sha": repository.sha,
            "branch": repository.branch,
            "dirty": repository.dirty,
        },
    )
    delivery = result.get("discord")
    if delivery == "published":
        print("live: one progress bubble opened in your team channel", file=sys.stderr)
    elif delivery == "channel_unbound":
        print(
            "live: synced to CogPortal; a team maintainer can choose the Discord channel with /cog",
            file=sys.stderr,
        )
    else:
        print("live: synced to CogPortal; Discord delivery is temporarily unavailable", file=sys.stderr)
    return _LiveRun(portal, token, str(result["sessionId"]))


def _run_view(args: argparse.Namespace, project_root: Path) -> str:
    """Resolve and score here; only the serialized report leaves this process."""

    live: Optional[_LiveRun] = None
    stdout_fd = None
    try:
        if args.json:
            # Imports can print through Python or native code. Redirect the
            # descriptor so neither can corrupt the parent's JSON report.
            sys.stdout.flush()
            stdout_fd = os.dup(1)
            os.dup2(2, 1)
        benchmark = load_benchmark(args.benchmark)
        adapter, weights = _submission_for(
            args.benchmark, benchmark, project_root, as_json=args.json
        )
        if args.command == "run" and args.live:
            # Live delivery owns worker threads. Start it beside execute in
            # the child; threads started before fork would not survive there.
            live = _start_live_run(args, benchmark, project_root)
            live.progress("preparing")
        report = execute(
            benchmark,
            adapter,
            project_root,
            smoke=args.command == "test",
            progress=live.progress if live else None,
            weights=weights,
        )
        if live:
            live.completed(report)
        return report.to_json()
    except BaseException as error:
        if live:
            live.failed(error)
        raise
    finally:
        # run_isolated uses _exit, which does not flush buffered student output.
        sys.stdout.flush()
        sys.stderr.flush()
        if stdout_fd is not None:
            os.dup2(stdout_fd, 1)
            os.close(stdout_fd)


def main(argv: Optional[Sequence[str]] = None) -> int:
    # Before anything reads a repository. Discovery runs student code whose
    # answer can depend on string hashing -- one 2026 repository builds its
    # IDF table by iterating a set -- and an interpreter's seed is fixed
    # before its first line, so this is the last moment a run can be made
    # reproducible. It replaces this process at most once and is a no-op
    # under a seed that is already pinned, which is what the hosted image
    # gives every sandbox.
    #
    # Only when this really is the command line. `main(["check", ...])` is
    # how the tests drive the CLI, and replacing the process there would
    # restart the test runner rather than the command.
    if argv is None:
        from .isolate import ensure_pinned_hash_seed

        ensure_pinned_hash_seed()

    parser = _parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    # The student's repository, resolved once, before any benchmark runs.
    # A benchmark plugin may change the process working directory: Week 1
    # chdirs into a private scratch directory because one audited repository
    # keeps a module-global relative `db.pkl`. Calling Path.cwd() after that
    # wrote the report into the scratch directory (which is deleted) and read
    # git state from a directory that is not a worktree, so `cogworks report`
    # after a successful run said "No local reports found".
    project_root = Path.cwd()
    try:
        if args.command in ("check", "doctor"):
            if args.command == "doctor":
                print(
                    "cogworks: `doctor` is deprecated; use `cogworks check`.",
                    file=sys.stderr,
                )
            result = _check(args.benchmark, args.json, project_root)
            if result == 0 and args.update_setup:
                _update_setup(
                    None,
                    ("clone", "environment", "project", "wiring"),
                    project_root,
                    args.benchmark,
                )
            return result
        if args.command in ("test", "run"):
            if not hasattr(os, "fork"):
                # Windows runs in-process, as _read_repository and survey do;
                # without fork this platform cannot offer crash containment.
                outcome = Outcome(COMPLETED, value=_run_view(args, project_root))
            else:
                # The native import crash in test_isolate also affects run/test.
                # Keep the adapter and the whole scored run inside this boundary.
                #
                # No budget. The boundary is here to contain a crash, and its
                # defaults are discovery's: 300 seconds of CPU and 3 GiB, sized
                # for reading a repository rather than for scoring one. The
                # measurement that bears on a local run is a local one:
                # carti4ce/week1_capstone took 381 seconds of evaluation on a
                # laptop (worker/execution/runner.ts records it beside the
                # hosted timings), so discovery's 300 would have cut a working
                # submission short and called it a timeout. Local runs had no
                # limit before this boundary existed and they still have none.
                sys.stdout.flush()
                sys.stderr.flush()
                if sys.platform == "darwin":
                    outcome = run_operation("run", {
                        "args": vars(args), "repository": str(project_root.resolve()),
                    }, scratch=project_root, timeout_seconds=None, memory_bytes=None)
                else:
                    outcome = run_isolated(
                        lambda: _run_view(args, project_root),
                        scratch=project_root, timeout_seconds=None, memory_bytes=None,
                    )
            if outcome.status != COMPLETED:
                if args.json:
                    print(json.dumps({
                        "benchmarkId": args.benchmark,
                        "status": outcome.status,
                        "detail": outcome.detail,
                    }, indent=2))
                else:
                    print("{} · LOCAL · NO RESULT".format(args.benchmark))
                    print("The run did not finish: {}.".format(outcome.detail))
                    print("No score was produced.")
                return 2
            report = LocalReport.from_json(outcome.value)
            path = save_report(report, project_root)
            _print_report(report, args.json)
            if not args.json:
                print("saved: {}".format(path))
            if args.update_setup:
                _update_setup(
                    args.portal if args.command == "run" else None,
                    (args.command,),
                    project_root,
                )
            return 0
        if args.command == "report":
            _print_report(
                LocalReport.from_json(
                    _resolve_report(args.path, project_root).read_text(encoding="utf-8")
                )
            )
            return 0
        if args.command == "link":
            portal = _portal(args.portal)
            print("Connecting to {}".format(portal))
            print(
                "CogPortal receives setup check names, package versions, and your GitHub repository; "
                "never source, paths, logs, predictions, scores, or environment variables."
            )
            start = start_device_link(portal)
            print("Open {} and confirm code {}.".format(start["verificationUri"], start["userCode"]))
            if not args.no_browser:
                webbrowser.open(start["verificationUri"])
            result = poll_device_link(
                portal,
                start["deviceCode"],
                int(start["pollIntervalSeconds"]),
                int(start["expiresAt"]),
            )
            save_token(portal, result["token"], int(result["expiresAt"]))
            print("Linked {}. Local commands still work offline.".format(platform.node() or "this device"))
            repository = repository_state(project_root)
            if repository.full_name:
                try:
                    _update_setup(portal, ("clone",), project_root)
                except PortalError as error:
                    print("setup: clone was not updated: {}".format(error), file=sys.stderr)
            else:
                print(
                    "setup: device linked; change into your team project before running "
                    "`cogworks check --benchmark {} --update-setup`.".format(
                        _installed_benchmark_hint()
                    ),
                    file=sys.stderr,
                )
            return 0
        if args.command == "sync":
            portal = _portal(args.portal)
            token = token_for(portal)
            if not token:
                raise PortalError("This portal is not linked. Run `cogworks link` first.")
            path = _resolve_report(args.path, project_root)
            report = LocalReport.from_json(path.read_text(encoding="utf-8"))
            sync_report(portal, token, json.loads(report.to_json()))
            for relative_path in report.weights_used:
                if Path(relative_path).is_absolute() or ".." in Path(relative_path).parts:
                    raise PortalError("Weight path must stay inside the repository: {}".format(relative_path))
                source = project_root / relative_path
                project_resolved = project_root.resolve()
                source_resolved = source.resolve()
                if source.is_symlink() or (
                    source_resolved != project_resolved
                    and project_resolved not in source_resolved.parents
                ):
                    raise PortalError(
                        "Weight path must be a regular file inside the repository: {}".format(
                            relative_path
                        )
                    )
                if not source.is_file():
                    raise PortalError("Weight file does not exist: {}".format(relative_path))

                tracked = subprocess.run(
                    ["git", "ls-files", "--error-unmatch", "--", relative_path],
                    cwd=str(project_root),
                    capture_output=True,
                ).returncode == 0
                if tracked:
                    if not report.repository.sha:
                        raise PortalError(
                            "The report has no commit to compare weight {} against.".format(
                                relative_path
                            )
                        )
                    comparison = subprocess.run(
                        ["git", "diff", "--quiet", report.repository.sha, "--", relative_path],
                        cwd=str(project_root),
                        capture_output=True,
                    )
                    if comparison.returncode == 0:
                        print(
                            "weights: {} is committed and travels with the repository".format(
                                relative_path
                            )
                        )
                        continue
                    if comparison.returncode != 1:
                        raise PortalError(
                            "Could not compare weight {} with report commit {}.".format(
                                relative_path, report.repository.sha
                            )
                        )
                    print(
                        "weights: {} differs from the report commit; uploading it".format(
                            relative_path
                        )
                    )

                # Workers caps request bodies at 100 MB on Free and Pro plans,
                # and this account's plan is not established. The largest 2026
                # corpus weight is 411 KB; Week 3's 200 MiB probe is separate.
                max_weight_bytes = 100 * 1024 * 1024
                size = source.stat().st_size
                if size > max_weight_bytes:
                    raise PortalError(
                        "Weight files may not exceed 100 MiB: {}".format(relative_path)
                    )
                try:
                    destination = upload_weight(
                        portal, token, report.report_id, relative_path, source
                    )
                except PortalError as error:
                    raise PortalError(
                        "Failed to sync weight {}: {}".format(relative_path, error)
                    ) from error
                print(
                    "weights: {} ({} bytes) uploaded to {}".format(
                        relative_path, size, destination
                    )
                )
            print("Synced {} as LOCAL · SELF-REPORTED.".format(report.report_id))
            return 0
        if args.command == "status":
            portal = _portal(args.portal)
            token = token_for(portal)
            if not token:
                raise PortalError("This portal is not linked. Run `cogworks link` first.")
            value = device_status(portal, token)
            print("GitHub   @{}".format(value["githubLogin"]))
            print("Team     {}".format(value["teamName"]))
            print("Repo     {}".format(value["repositoryFullName"]))
            print(
                "Discord  team channel {}".format(
                    "chosen" if value.get("discordChannelId") else "not chosen"
                )
            )
            print("Device   {}".format(value["deviceName"]))
            print("Expires  {}".format(_format_expiry(int(value["deviceExpiresAt"]))))
            print("Portal   {}".format(portal))
            return 0
    except KeyboardInterrupt:
        print("\ncogworks: interrupted", file=sys.stderr)
        return 130
    except (ContractError, PluginError, PortalError, OSError, ValueError) as error:
        print("cogworks: {}".format(error), file=sys.stderr)
        return 2
    return 2
