from __future__ import annotations

import argparse
import json
import os
import platform
import queue
import socket
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
from datetime import datetime, timezone
from contextlib import contextmanager
from dataclasses import replace
from functools import partial
from pathlib import Path
from typing import Any, Callable, NamedTuple, Optional, Sequence, Tuple
from urllib.parse import urlparse

from . import __version__
from .apploader import SubmissionFileError, SubmissionFileMissing
from .environment import gap_note, local_gap
from .execution import ExecutionPaths, ExecutionCopyError, entered_project, private_project
from .isolate import COMPLETED, CRASHED, Outcome
from . import isolate
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
)
from .models import LocalReport
from .resolve import SubmissionReport, from_spec, resolve
from .discover import _Redirects
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
    # run_operation sends vars(args) as JSON. Every new run flag must remain
    # JSON-safe; type=Path or another live object would break the exec path.
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


def _discover(benchmark: str, project_root: Path, as_json: bool, *, spec=None, project=None):
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

    # _run_view already built this spec to hold its course mapping through
    # scoring. Reuse that child-local object rather than load its data twice.
    if spec is None:
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
            project=project,
        )
    except Exception as error:  # noqa: BLE001
        if watcher is not None:
            watcher.done()
        return None, None, "{}: {}".format(type(error).__name__, error)

    # Off the record, not off `submission.discovery`. A binding that is handed
    # over lets the search's reading go and keeps what it found on the record
    # (`resolve.Submission.fresh`), so reading the attribute here reported no
    # search at all for exactly the repositories that resolved through one.
    return submission, submission.to_dict().get("discovery"), None


class _Scoreable(NamedTuple):
    """The one answer `check` reports and `run` acts on.

    `factory` is None exactly when there is nothing to score. Every other
    field is the evidence behind that, for the report.
    """

    factory: Optional[Callable[..., Any]]
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


def _scoreable(name: str, benchmark, project_root: Path, *, as_json: bool, spec=None, spec_error=None, project=None) -> _Scoreable:
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
                factory, "file", None, None, declared_source, declared_detail
            )
    except PluginError as error:
        declared_error = str(error)
        if isinstance(error.__cause__, SubmissionFileError) and not isinstance(error.__cause__, SubmissionFileMissing):
            return _Scoreable(None, None, None, None, "file", None, declared_error)

    if spec_error is not None:
        # A declaration needs no discovery data. Without one, preserve the
        # original cold-cache failure instead of retrying or hiding its cause.
        raise spec_error
    submission, survey, unavailable = _discover(name, project_root, as_json, spec=spec, project=project)
    build = getattr(benchmark, "submission_from_discovery", None)
    if submission is None or not submission.ready or not callable(build):
        return _Scoreable(
            None, None, submission, survey,
            declared_source, declared_detail, declared_error, unavailable,
        )
    return _Scoreable(
        (lambda *args, **kwargs: build(submission)),
        "discovery",
        submission,
        survey,
        declared_source,
        declared_detail,
        None,
    )


def _submission_for(name: str, benchmark, project_root: Path, *, as_json: bool, spec=None, spec_error=None, project=None):
    """What to score, or a refusal."""

    scoreable = _scoreable(name, benchmark, project_root, as_json=as_json, spec=spec, spec_error=spec_error, project=project)
    if scoreable.factory is None:
        # The report already said why in full. Repeating it here would print
        # the same paragraphs twice, so this points at the command that
        # explains it.
        raise PluginError(
            "Nothing in this repository could be scored yet. Run "
            "`cogworks check --benchmark {}` to see what was found.".format(name)
        )
    return scoreable.factory


@contextmanager
def _student_output(as_json: bool):
    # Both Python prints and native writes must stay off the JSON descriptor.
    # A separate stream also lets no-fork code close stdout without closing ours.
    original_stdout = sys.stdout
    saved_fd = os.dup(1)
    output = os.fdopen(os.dup(2 if as_json else 1), "w", buffering=1,
                       encoding="utf-8", errors="replace")
    try:
        isolate._flush_streams()
        if as_json:
            os.dup2(2, 1)
        sys.stdout = output
        yield
    finally:
        isolate._flush_streams()
        sys.stdout = original_stdout
        os.dup2(saved_fd, 1)
        os.close(saved_fd)
        output.close()


def _check_view(name: str, project_root: Path, as_json: bool, *, project=None) -> dict:
    """Read the repository and answer the readiness question, as plain data.

    This is the whole of `check` that touches student code, and it is the unit
    that runs in the child process. Its report is JSON data; only the parent
    reconstructs the dataclasses that render_check reads.
    """

    project = project or ExecutionPaths(project_root, project_root)
    with entered_project(project), _student_output(as_json):
        benchmark = load_benchmark(name)
        scoreable = _scoreable(name, benchmark, project_root, as_json=as_json, project=project)
        view = {
            "ready": scoreable.factory is not None,
            "source": scoreable.source,
            "report": None if scoreable.submission is None else scoreable.submission.report().to_dict(),
            "survey": scoreable.survey,
            "declaredSource": scoreable.declared_source,
            "declaredDetail": scoreable.declared_detail,
            "declaredError": scoreable.declared_error,
            "discoveryUnavailable": scoreable.discovery_unavailable,
        }
        return project.describe(view)


def _send_progress(fd: int, phase: str, current=None, total=None) -> None:
    # Progress is optional telemetry, not the result. A full socket must not
    # block scoring; the parent owns heartbeat and attempts terminal delivery.
    payload = json.dumps([phase, current, total]).encode("utf-8")
    if len(payload) <= 4096:
        try:
            os.write(fd, payload)
        except OSError:
            pass


def _receive_progress(reader: socket.socket, live) -> int:
    live.start()
    received = 0
    # Match the live sender's bounded queue so a chatty child cannot keep the
    # parent from checking its result and exit status.
    for _ in range(32):
        try:
            payload = reader.recv(4096)
        except BlockingIOError:
            break
        received += 1
        try:
            phase, current, total = json.loads(payload)
        except (ValueError, TypeError, UnicodeError):
            continue
        if phase not in ("preparing", "contract_check", "evaluating", "scoring"):
            continue
        if any(value is not None and (type(value) is not int or value < 0) for value in (current, total)):
            continue
        live.progress(phase, current, total)
    return received


@contextmanager
def _progress_channel(live, backend):
    if live is None or backend is None:
        yield (live.progress if live else None), None, None
        return
    # Datagram boundaries prevent a partial write at native exit from becoming
    # the next progress event. Only the parent assigns portal event sequences.
    reader, writer = socket.socketpair(type=socket.SOCK_DGRAM)
    with reader, writer:
        reader.setblocking(False)
        writer.setblocking(False)
        poll = partial(_receive_progress, reader, live)
        try:
            yield partial(_send_progress, writer.fileno()), writer.fileno(), poll
        finally:
            # The backend has reaped the child and stopped its descendants.
            while poll():
                pass


def _local_operation(operation: str, project_root: Path, *, live=None, **arguments) -> Outcome:
    # The parent keeps the project copy through import, preparation and scoring.
    # Scratch-first imports and probes still use separate temporary directories;
    # files generated in those scratch directories do not survive to scoring.
    try:
        with private_project(project_root) as project:
            backend = isolate._isolation_backend()
            with _progress_channel(live, backend) as (progress, progress_fd, poll):
                def work():
                    if operation == "check":
                        return _check_view(
                            arguments["name"], project.execution, arguments["as_json"], project=project
                        )
                    return _run_view(
                        argparse.Namespace(**arguments["args"]), project.execution,
                        project=project, progress=progress,
                    )

                if backend is None:
                    # This cannot contain a native crash. Ordinary Python failures
                    # still belong to the operation, not to the parent renderer.
                    try:
                        outcome = Outcome(COMPLETED, value=work())
                    except (Exception, SystemExit) as error:
                        outcome = Outcome(isolate.RAISED, detail="{}: {}".format(type(error).__name__, error))
                else:
                    # Scoring retains its existing unbounded CPU/wall policy. One
                    # measured local evaluation took 381 seconds, longer than the
                    # discovery default; this copy is not a new scoring deadline.
                    limits = {"timeout_seconds": None, "memory_bytes": None} if operation == "run" else {}
                    if poll is not None:
                        limits["on_poll"] = poll
                    if backend is isolate.run_operation:
                        request = dict(arguments, repository=str(project.execution), original=str(project.original))
                        if progress_fd is not None:
                            request["progress_fd"] = progress_fd
                            limits["pass_fds"] = (progress_fd,)
                        outcome = backend(operation, request, scratch=project.execution, **limits)
                    else:
                        outcome = backend(work, scratch=project.execution, **limits)
            return replace(outcome, detail=project.describe(outcome.detail))
    except ExecutionCopyError as error:
        return Outcome(CRASHED, detail=str(error))


def _validate_survey(record) -> None:
    """Validate the discovery record before any parent-side renderer reads it."""
    if not isinstance(record, dict):
        raise TypeError("survey must be an object")
    for field in ("root", "rootReason", "unreadReason", "endedWhileReading"):
        if field in record and not isinstance(record[field], str):
            raise TypeError("survey.{} must be text".format(field))
    if "unread" in record and type(record["unread"]) is not bool:
        raise TypeError("survey.unread must be a boolean")
    for field in ("considered", "stubbed", "stubCalls"):
        if field in record and (
            not isinstance(record[field], list) or
            not all(isinstance(item, str) for item in record[field])
        ):
            raise TypeError("survey.{} must be a list of text".format(field))
    for field, required in (("modules", ("name",)), ("skipped", ("name", "detail"))):
        entries = record.get(field, [])
        if not isinstance(entries, list):
            raise TypeError("survey.{} must be a list".format(field))
        for index, entry in enumerate(entries):
            location = "survey.{}[{}]".format(field, index)
            if not isinstance(entry, dict):
                raise TypeError("{} must be an object".format(location))
            for key in required:
                if key not in entry:
                    raise ValueError("{}.{} is missing".format(location, key))
            for key in ("name", "path", "origin", "detail", "reason", "importedFrom", "note"):
                if key in entry and not isinstance(entry[key], str):
                    raise TypeError("{}.{} must be text".format(location, key))
            if "missing" in entry and entry["missing"] is not None and not isinstance(entry["missing"], str):
                raise TypeError("{}.missing must be text or null".format(location))
            if "futureAnnotations" in entry and type(entry["futureAnnotations"]) is not bool:
                raise TypeError("{}.futureAnnotations must be a boolean".format(location))
            for key in ("redirected", "redirectNote"):
                if key in entry and (
                    not isinstance(entry[key], list) or
                    not all(isinstance(item, str) for item in entry[key])
                ):
                    raise TypeError("{}.{} must be a list of text".format(location, key))


#: What `_check` reads off a check view. The child builds it in `_check_view`
#: and the parent indexes it; naming the contract in one place is what lets
#: the boundary reject a malformed one instead of the parent raising on it.
_CHECK_VIEW_KEYS = (
    "report", "survey", "ready", "source", "declaredDetail",
    "declaredSource", "declaredError", "discoveryUnavailable",
)


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

    outcome = _local_operation("check", project_root, name=name, as_json=as_json)
    view = None
    if outcome.status == COMPLETED:
        # One rehydration site for exec, fork, and in-process Windows. The
        # envelope says the child finished; it says nothing about the shape of
        # what it returned, and `_check` indexes every one of these keys. A
        # child that publishes `{"report": null}` used to pass here and raise
        # KeyError three frames later, in the parent, outside the boundary.
        try:
            if not isinstance(outcome.value, dict):
                raise TypeError("expected a check report object")
            missing = [key for key in _CHECK_VIEW_KEYS if key not in outcome.value]
            if missing:
                raise KeyError("check report is missing {}".format(", ".join(missing)))
            view = dict(outcome.value)
            if type(view["ready"]) is not bool:
                raise TypeError("check report ready must be a boolean")
            for field in ("source", "declaredDetail", "declaredSource", "declaredError", "discoveryUnavailable"):
                if view[field] is not None and not isinstance(view[field], str):
                    raise TypeError("check report {} must be text or null".format(field))
            if view["survey"] is not None:
                _validate_survey(view["survey"])
            if view["report"] is not None:
                view["report"] = SubmissionReport.from_dict(view["report"])
        except (KeyError, TypeError, ValueError) as error:
            view = None
            outcome = replace(outcome, status=CRASHED, value=None,
                              detail="invalid check report: {}".format(error))
    if diagnostics is not None:
        diagnostics.update(outcome.diagnostics())
    return view, outcome.status, outcome.detail


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
    declaration_error = ""
    search_unavailable = ""
    if checks["benchmarkLoadable"]:
        diagnostics: dict = {}
        view, status, detail = _read_repository(
            benchmark, project_root, as_json, diagnostics=diagnostics
        )
        if view is None:
            unread_detail = detail or "the process reading it ended without saying why"
            checks["submissionError"] = (
                "Could not check this repository ({}): {}".format(status, unread_detail)
            )
            checks["isolationDetail"] = diagnostics
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
                if not view["ready"] and submission is None and view["declaredSource"] == "file":
                    declaration_error = view["declaredError"]
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
            declaration_error=declaration_error,
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
        self._batch_attempted = threading.Event()
        self._warned = False
        self._lock = threading.Lock()
        self._history = []
        self._sender = threading.Thread(target=self._send_loop, name="cogworks-live-sender", daemon=True)
        self._heartbeat = threading.Thread(target=self._heartbeat_loop, name="cogworks-live-heartbeat", daemon=True)
        self._started = False

    def start(self) -> None:
        # Construction precedes fork; only parent polling or direct progress
        # starts threads, after the execution child exists.
        with self._lock:
            self._start_locked()

    def _start_locked(self) -> None:
        if not self._started:
            self._started = True
            self._sender.start()
            self._heartbeat.start()

    def _payload(self, payload: dict) -> dict:
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

    def _queue_locked(self, payload: dict, terminal: bool = False) -> Optional[threading.Event]:
        # The caller holds the same lock for phase, closure, sequence, history
        # and queue insertion. A heartbeat cannot pass a terminal event.
        done = threading.Event() if terminal else None
        event = self._payload(payload)
        self._history.append((event, not terminal and event.get("code") == "evaluation.progress"))
        while len(self._history) > 32:
            removable = next(
                (index for index, (_, progress) in enumerate(self._history) if progress), 0,
            )
            self._history.pop(removable)
        try:
            self._events.put_nowait((event, done))
        except queue.Full:
            if terminal:
                # Progress may be dropped; reserve a queue slot for the final
                # event without blocking while holding the state lock.
                try:
                    self._events.get_nowait()
                except queue.Empty:
                    pass  # The sender already made room.
                else:
                    self._events.task_done()
                self._events.put_nowait((event, done))
        return done

    def _send_loop(self) -> None:
        while True:
            payload, done = self._events.get()
            try:
                if done:
                    # Let the parent attempt its independent batch first. This
                    # retry uses the terminal event already in that history.
                    self._batch_attempted.wait()
                elif self._closed.is_set():
                    continue
                try:
                    send_local_run_event(self.portal, self.token, self.session_id, payload)
                except (PortalError, OSError, ValueError) as error:
                    if not self._warned:
                        self._warned = True
                        print("cogworks: live updates paused: {}".format(error), file=sys.stderr)
            finally:
                if done:
                    done.set()
                self._events.task_done()
            if done:
                return

    def _heartbeat_loop(self) -> None:
        while not self._closed.wait(2.0):
            with self._lock:
                if self._closed.is_set():
                    return
                self._queue_locked(_live_progress_payload(self.phase, self.current, self.total))

    @staticmethod
    def _code(phase: str) -> str:
        return {
            "preparing": "repository.ready",
            "contract_check": "contract.checking",
            "evaluating": "evaluation.started",
            "scoring": "scoring.started",
        }.get(phase, "evaluation.progress")

    def progress(self, phase: str, current: Optional[int] = None, total: Optional[int] = None) -> None:
        with self._lock:
            if self._closed.is_set():
                return
            self._start_locked()
            if self.phase == "contract_check" and phase == "evaluating":
                self._queue_locked({"type": "progress", "phase": "contract_check", "code": "contract.passed"})
            self.phase = phase
            self.current = current
            self.total = total
            self._queue_locked(_live_progress_payload(phase, current, total))

    def _finish(self, payload: dict) -> None:
        deadline = time.monotonic() + 5.0
        with self._lock:
            if self._closed.is_set():
                return
            self._closed.set()
            self._start_locked()
            if payload["type"] == "failed":
                payload = dict(payload, phase=self.phase)
            done = self._queue_locked(payload, terminal=True)
            history = [event for event, _ in self._history]
        # The single-event request may be stalled. The parent's existing
        # five-second batch request must not wait behind that sender.
        try:
            send_local_run_event_batch(self.portal, self.token, self.session_id, history)
        except (PortalError, OSError, ValueError) as error:
            print("cogworks: final live update was delayed: {}".format(error), file=sys.stderr)
            self._batch_attempted.set()
            done.wait(max(0.0, deadline - time.monotonic()))
        finally:
            self._batch_attempted.set()
        self._heartbeat.join(timeout=max(0.0, deadline - time.monotonic()))

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
        self._finish({"type": "failed", "code": code})


def _live_identity(name: str, project_root: Path) -> dict:
    # Only the installed benchmark supplies session identity. Remove repository
    # import paths and leave its cwd so a local module cannot shadow that plugin
    # during identity loading. Do not resolve a submission or call discovery here.
    previous_path = list(sys.path)
    previous_cwd = Path.cwd()
    paths = ExecutionPaths(project_root, project_root)
    with tempfile.TemporaryDirectory(prefix="cogworks-live-") as temporary:
        try:
            installed_paths = []
            for entry in previous_path:
                path = Path(entry or project_root).resolve()
                if paths.environment_path(path) or (path != project_root and project_root not in path.parents):
                    installed_paths.append(str(path))
            sys.path[:] = installed_paths
            os.chdir(temporary)
            with _student_output(True):
                benchmark = load_benchmark(name)
                return {"benchmark_id": benchmark.benchmark_id,
                        "benchmark_version": benchmark.benchmark_version}
        finally:
            os.chdir(previous_cwd)
            sys.path[:] = previous_path


def _live_benchmark(name: str, project_root: Path) -> dict:
    # Importing the installed plugin can initialize native libraries. Keep even
    # that trusted import out of the parent that will launch the scoring child.
    backend = isolate._isolation_backend()
    if backend is None:
        try:
            outcome = Outcome(COMPLETED, value=_live_identity(name, project_root))
        except (Exception, SystemExit) as error:
            outcome = Outcome(isolate.RAISED, detail="{}: {}".format(type(error).__name__, error))
    elif backend is isolate.run_operation:
        outcome = backend("live_identity", {"name": name, "repository": str(project_root)})
    else:
        outcome = backend(partial(_live_identity, name, project_root))
    if outcome.status != COMPLETED:
        raise PluginError("Cannot load live benchmark identity: {}".format(outcome.detail))
    identity = outcome.value
    if (not isinstance(identity, dict)
            or set(identity) != {"benchmark_id", "benchmark_version"}
            or not isinstance(identity["benchmark_id"], str) or not identity["benchmark_id"]
            or type(identity["benchmark_version"]) is not int or identity["benchmark_version"] < 1):
        raise PluginError("Cannot load live benchmark identity: expected benchmark_id text and a positive benchmark_version integer")
    return identity


def _start_live_run(
    args: argparse.Namespace, benchmark: dict, project_root: Path
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
            "benchmarkId": benchmark["benchmark_id"],
            "benchmarkVersion": benchmark["benchmark_version"],
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


def _run_view(args: argparse.Namespace, project_root: Path, *, project=None, progress=None) -> str:
    """Resolve and score here; only the serialized report leaves this process."""

    project = project or ExecutionPaths(project_root, project_root)
    with entered_project(project), _student_output(args.json):
        if progress:
            progress("preparing")
        benchmark = load_benchmark(args.benchmark)
        describes = getattr(benchmark, "discovery", None)
        spec, spec_error = None, None
        try:
            spec = describes() if callable(describes) else None
        except Exception as error:
            # Week 3 builds discovery from cached course data. An explicit
            # submission can run and fetch that data without this spec.
            spec_error = error
        # For as long as student code can run, a course artifact the benchmark
        # owns resolves to its validated copy, including attribute reads while
        # scoring. The spec and mapping are built here, never sent across exec.
        with _Redirects(dict(getattr(spec, "resource_files", {}) or {})):
            adapter = _submission_for(
                args.benchmark, benchmark, project_root, as_json=args.json, spec=spec,
                spec_error=spec_error, project=project
            )
            # execute's cwd argument supplies Git attribution; student code
            # continues to run with the private working directory above.
            report = execute(
                benchmark,
                adapter,
                project.original,
                smoke=args.command == "test",
                progress=progress,
            )
            serialized = json.dumps(project.describe(json.loads(report.to_json())))
            return serialized


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
    live = None
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
            if args.command == "run" and args.live:
                # This loads the trusted installed benchmark entry point only.
                # Submission resolution, discovery and scoring stay in the child.
                with _student_output(args.json):
                    benchmark = _live_benchmark(args.benchmark, project_root)
                live = _start_live_run(args, benchmark, project_root)
            outcome = _local_operation("run", project_root, live=live, args=vars(args))
            if outcome.status != COMPLETED:
                if live:
                    failure = TimeoutError if outcome.status == isolate.TIMED_OUT else RuntimeError
                    if outcome.status == isolate.RAISED:
                        # _child writes the exact exception type name followed
                        # by ': '. Recognize only these existing failure types;
                        # this does not reconstruct an exception from the child.
                        for error_type in (ContractError, MemoryError, TimeoutError):
                            if outcome.detail.startswith(error_type.__name__ + ": "):
                                failure = error_type
                                break
                    live.failed(failure(outcome.detail))
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
            # `_run_view` returns the report as JSON text. A completed
            # envelope carrying None, "{}" or "[]" reached `from_json` and
            # raised TypeError or KeyError in the parent, which is the one
            # place this boundary exists to keep failures out of.
            try:
                report = LocalReport.from_json(outcome.value)
            except (AttributeError, KeyError, OverflowError, TypeError, ValueError) as error:
                message = "invalid run report: {}: {}".format(
                    type(error).__name__, error
                )
                if live:
                    live.failed(ValueError(message))
                if args.json:
                    print(json.dumps({
                        "benchmarkId": args.benchmark,
                        "status": CRASHED,
                        "detail": message,
                    }, indent=2))
                else:
                    print("{} · LOCAL · NO RESULT".format(args.benchmark))
                    print("The run did not finish: {}.".format(message))
                    print("No score was produced.")
                return 2
            path = save_report(report, project_root)
            if live:
                live.completed(report)
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
        if live:
            live.failed(RuntimeError("interrupted"))
        print("\ncogworks: interrupted", file=sys.stderr)
        return 130
    except (ContractError, PluginError, PortalError, OSError, ValueError) as error:
        if live:
            live.failed(error)
        print("cogworks: {}".format(error), file=sys.stderr)
        return 2
    finally:
        if live and not live._closed.is_set():
            live.failed(RuntimeError("run did not finish"))
    return 2
