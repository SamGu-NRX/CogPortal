from __future__ import annotations

import argparse
import json
import os
import platform
import queue
import sys
import threading
import time
import uuid
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Sequence
from urllib.parse import urlparse

from . import __version__
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
from .plugins import PluginError, load_benchmark, load_submission, plugin_names
from .project import repository_state
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
        ("test", "run one fast contract case"),
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
            command.add_argument("--portal")
    report = subparsers.add_parser("report", help="show a saved local report")
    report.add_argument("path", nargs="?")
    link = subparsers.add_parser("link", help="link this device to CogPortal")
    link.add_argument("--portal")
    link.add_argument("--no-browser", action="store_true")
    sync = subparsers.add_parser("sync", help="explicitly sync one local report")
    sync.add_argument("path", nargs="?")
    sync.add_argument("--portal")
    status = subparsers.add_parser("status", help="show this device's CogPortal connection")
    status.add_argument("--portal")
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


def _setup_payload(checks: Sequence[str]) -> dict:
    repository = repository_state(Path.cwd())
    if not repository.full_name:
        raise PortalError(
            "This directory is not a GitHub worktree with an `origin` remote. "
            "Change into your team project and retry."
        )
    return {
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


def _update_setup(portal_value: Optional[str], checks: Sequence[str]) -> None:
    portal = _portal(portal_value)
    token = token_for(portal)
    if not token:
        raise PortalError(
            "This CogPortal connection is missing, expired, or revoked. "
            "Run `cogworks link --portal {}` and retry.".format(portal)
        )
    result = update_setup_checks(portal, token, _setup_payload(checks))
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
        value = ("{:.%df}" % metric.precision).format(metric.value)
        print("{}: {}{}".format(metric.label, value, " " + metric.unit if metric.unit else ""))
    if report.repository.sha:
        print("commit: {}{}".format(report.repository.sha[:7], " (dirty)" if report.repository.dirty else ""))
    for diagnostic in report.diagnostics:
        print("note: {}".format(diagnostic))


def _resolve_report(path_value: Optional[str]) -> Path:
    if path_value:
        return Path(path_value).expanduser().resolve()
    latest = latest_report(Path.cwd())
    if latest is None:
        raise ContractError("No local reports found. Run `cogworks run` first.")
    return latest


def _check(benchmark: str, as_json: bool) -> int:
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
    repository = repository_state(Path.cwd())
    checks = {
        "python": platform.python_version(),
        "canonicalHostedPython": "3.11",
        "contractVersion": contract_group,
        "benchmarkInstalled": benchmark in benchmark_plugins,
        "submissionInstalled": benchmark in submission_plugins,
        "gitRepository": bool(repository.sha),
        "repositoryFullName": repository.full_name,
    }
    checks["benchmarkLoadable"] = False
    checks["submissionLoadable"] = False
    if checks["benchmarkInstalled"] and benchmark_group.endswith(".v2"):
        plugin = load_benchmark(benchmark)
        checks["benchmarkLoadable"] = True
        checks["modelCache"] = model_cache_status()
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
    if checks["submissionInstalled"]:
        load_submission(benchmark, contract_group)
        checks["submissionLoadable"] = True
    if as_json:
        print(json.dumps(checks, indent=2, sort_keys=True))
    else:
        for key, value in checks.items():
            print("{:<24} {}".format(key, value))
        if benchmark_group.endswith(".v2"):
            print("\nCaches are populated when you explicitly run `cogworks test` or `cogworks run`.")
    required = (
        "gitRepository",
        "repositoryFullName",
        "benchmarkInstalled",
        "submissionInstalled",
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


def _start_live_run(args: argparse.Namespace, benchmark: object) -> _LiveRun:
    portal = _portal(args.portal)
    token = token_for(portal)
    if not token:
        raise PortalError("This portal is not linked. Run `cogworks link` first.")
    repository = repository_state(Path.cwd())
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


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    live: Optional[_LiveRun] = None
    try:
        if args.command in ("check", "doctor"):
            if args.command == "doctor":
                print(
                    "cogworks: `doctor` is deprecated; use `cogworks check`.",
                    file=sys.stderr,
                )
            result = _check(args.benchmark, args.json)
            if result == 0 and args.update_setup:
                _update_setup(None, ("clone", "environment", "project", "wiring"))
            return result
        if args.command in ("test", "run"):
            benchmark = load_benchmark(args.benchmark)
            adapter = load_submission(args.benchmark, str(benchmark.contract_version))
            if args.command == "run" and args.live:
                live = _start_live_run(args, benchmark)
                live.progress("preparing")
            report = execute(
                benchmark,
                adapter,
                Path.cwd(),
                smoke=args.command == "test",
                progress=live.progress if live else None,
            )
            path = save_report(report, Path.cwd())
            if live:
                live.completed(report)
            _print_report(report, args.json)
            if not args.json:
                print("saved: {}".format(path))
            if args.update_setup:
                _update_setup(args.portal if args.command == "run" else None, (args.command,))
            return 0
        if args.command == "report":
            _print_report(LocalReport.from_json(_resolve_report(args.path).read_text(encoding="utf-8")))
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
            repository = repository_state(Path.cwd())
            if repository.full_name:
                try:
                    _update_setup(portal, ("clone",))
                except PortalError as error:
                    print("setup: clone was not updated: {}".format(error), file=sys.stderr)
            else:
                print(
                    "setup: device linked; change into your team project before running "
                    "`cogworks check --benchmark vision-recognition --update-setup`.",
                    file=sys.stderr,
                )
            return 0
        if args.command == "sync":
            portal = _portal(args.portal)
            token = token_for(portal)
            if not token:
                raise PortalError("This portal is not linked. Run `cogworks link` first.")
            path = _resolve_report(args.path)
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
            print("Discord  {}".format(
                "#{}".format(value["discordChannelId"])
                if value.get("discordChannelId") else "team channel not chosen"
            ))
            print("Device   {}".format(value["deviceName"]))
            expires = datetime.fromtimestamp(
                int(value["deviceExpiresAt"]) / 1000,
                tz=timezone.utc,
            ).isoformat().replace("+00:00", "Z")
            print("Expires  {}".format(expires))
            print("Portal   {}".format(portal))
            return 0
    except KeyboardInterrupt:
        if live:
            live.failed(KeyboardInterrupt())
        print("\ncogworks: interrupted", file=sys.stderr)
        return 130
    except (ContractError, PluginError, PortalError, OSError, ValueError) as error:
        if live:
            live.failed(error)
        print("cogworks: {}".format(error), file=sys.stderr)
        return 2
    return 2
