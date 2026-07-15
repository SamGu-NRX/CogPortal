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
)
from .models import LocalReport
from .plugins import PluginError, load_benchmark, load_submission, plugin_names
from .project import repository_state
from .runner import ContractError, execute
from .storage import latest_report, save_report, save_token, token_for

DEFAULT_PORTAL = os.environ.get("COGPORTAL_URL", "https://cogportal-dev.sillion.app")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cogbench", description="Run CogWorks practice benchmarks locally.")
    parser.add_argument("--version", action="version", version=__version__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("doctor", "check the local benchmark environment"),
        ("test", "run one fast contract case"),
        ("run", "run the public local practice benchmark"),
    ):
        command = subparsers.add_parser(name, help=help_text)
        command.add_argument("--benchmark", required=True)
        command.add_argument("--json", action="store_true")
        if name == "run":
            command.add_argument(
                "--live",
                action="store_true",
                help="share one live progress bubble with your linked team",
            )
            command.add_argument("--portal", default=DEFAULT_PORTAL)
    report = subparsers.add_parser("report", help="show a saved local report")
    report.add_argument("path", nargs="?")
    link = subparsers.add_parser("link", help="optionally link this device to CogPortal")
    link.add_argument("--portal", default=DEFAULT_PORTAL)
    link.add_argument("--no-browser", action="store_true")
    sync = subparsers.add_parser("sync", help="explicitly sync one local report")
    sync.add_argument("path", nargs="?")
    sync.add_argument("--portal", default=DEFAULT_PORTAL)
    status = subparsers.add_parser("status", help="show this device's CogPortal connection")
    status.add_argument("--portal", default=DEFAULT_PORTAL)
    return parser


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
        raise ContractError("No local reports found. Run `cogbench run` first.")
    return latest


def _doctor(benchmark: str, as_json: bool) -> int:
    benchmark_plugins = plugin_names("cogworks.benchmarks.v1")
    submission_plugins = plugin_names("cogworks.submissions.v1")
    checks = {
        "python": platform.python_version(),
        "canonicalHostedPython": "3.11",
        "benchmarkInstalled": benchmark in benchmark_plugins,
        "submissionInstalled": benchmark in submission_plugins,
        "gitRepository": (Path.cwd() / ".git").exists(),
    }
    if as_json:
        print(json.dumps(checks, indent=2, sort_keys=True))
    else:
        for key, value in checks.items():
            print("{:<24} {}".format(key, value))
    return 0 if checks["benchmarkInstalled"] and checks["submissionInstalled"] else 1


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
        self._sender = threading.Thread(target=self._send_loop, name="cogbench-live-sender", daemon=True)
        self._heartbeat = threading.Thread(target=self._heartbeat_loop, name="cogbench-live-heartbeat", daemon=True)
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
                print("cogbench: final live update could not be queued", file=sys.stderr)
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
                    print("cogbench: live updates paused: {}".format(error), file=sys.stderr)
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
                print("cogbench: final live update was delayed: {}".format(error), file=sys.stderr)
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
    portal = args.portal.rstrip("/")
    token = token_for(portal)
    if not token:
        raise PortalError("This portal is not linked. Run `cogbench link` first.")
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
    args = _parser().parse_args(argv)
    live: Optional[_LiveRun] = None
    try:
        if args.command == "doctor":
            return _doctor(args.benchmark, args.json)
        if args.command in ("test", "run"):
            benchmark = load_benchmark(args.benchmark)
            adapter = load_submission(args.benchmark)
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
            return 0
        if args.command == "report":
            _print_report(LocalReport.from_json(_resolve_report(args.path).read_text(encoding="utf-8")))
            return 0
        if args.command == "link":
            start = start_device_link(args.portal)
            print("Open {} and confirm code {}.".format(start["verificationUri"], start["userCode"]))
            if not args.no_browser:
                webbrowser.open(start["verificationUri"])
            result = poll_device_link(
                args.portal,
                start["deviceCode"],
                int(start["pollIntervalSeconds"]),
                int(start["expiresAt"]),
            )
            save_token(args.portal.rstrip("/"), result["token"], int(result["expiresAt"]))
            print("Linked {}. Local commands still work offline.".format(platform.node() or "this device"))
            return 0
        if args.command == "sync":
            portal = args.portal.rstrip("/")
            token = token_for(portal)
            if not token:
                raise PortalError("This portal is not linked. Run `cogbench link` first.")
            path = _resolve_report(args.path)
            report = LocalReport.from_json(path.read_text(encoding="utf-8"))
            sync_report(portal, token, json.loads(report.to_json()))
            print("Synced {} as LOCAL · SELF-REPORTED.".format(report.report_id))
            return 0
        if args.command == "status":
            portal = args.portal.rstrip("/")
            token = token_for(portal)
            if not token:
                raise PortalError("This portal is not linked. Run `cogbench link` first.")
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
    except (ContractError, PluginError, PortalError, OSError, ValueError) as error:
        if live:
            live.failed(error)
        print("cogbench: {}".format(error), file=sys.stderr)
        return 2
    return 2
