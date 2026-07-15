from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import webbrowser
import time
import uuid
from pathlib import Path
from typing import Optional, Sequence

from . import __version__
from .client import (
    PortalError,
    poll_device_link,
    send_local_run_event,
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


class _LiveRun:
    def __init__(self, portal: str, token: str, session_id: str) -> None:
        self.portal = portal
        self.token = token
        self.session_id = session_id
        self.sequence = 0
        self.phase = "preparing"

    def _send(self, payload: dict) -> None:
        payload.update(
            {
                "eventId": "localevent_" + uuid.uuid4().hex,
                "sequence": self.sequence,
                "occurredAt": int(time.time() * 1000),
            }
        )
        self.sequence += 1
        try:
            send_local_run_event(self.portal, self.token, self.session_id, payload)
        except PortalError as error:
            print("cogbench: live update missed: {}".format(error), file=sys.stderr)

    def progress(self, phase: str) -> None:
        self.phase = phase
        self._send({"type": "progress", "phase": phase})

    def completed(self, report: LocalReport) -> None:
        self._send({"type": "completed", "report": report.to_wire()})

    def failed(self, error: Exception) -> None:
        detail = str(error).strip() or error.__class__.__name__
        self._send({"type": "failed", "phase": self.phase, "detail": detail[:240]})


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
            "dirty": repository.dirty,
        },
    )
    delivery = result.get("discord")
    if delivery == "published":
        print("live: one progress bubble opened in your team channel", file=sys.stderr)
    elif delivery == "channel_unbound":
        print("live: synced to CogPortal; a team maintainer can choose the Discord channel with /cog", file=sys.stderr)
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
    except (ContractError, PluginError, PortalError, OSError, ValueError) as error:
        if live:
            live.failed(error)
        print("cogbench: {}".format(error), file=sys.stderr)
        return 2
    return 2
