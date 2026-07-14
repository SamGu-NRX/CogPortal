from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import webbrowser
from pathlib import Path
from typing import Optional, Sequence

from . import __version__
from .client import PortalError, poll_device_link, start_device_link, sync_report
from .models import LocalReport
from .plugins import PluginError, plugin_names
from .runner import ContractError, execute_installed
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


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "doctor":
            return _doctor(args.benchmark, args.json)
        if args.command in ("test", "run"):
            report = execute_installed(args.benchmark, Path.cwd(), smoke=args.command == "test")
            path = save_report(report, Path.cwd())
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
        print("cogbench: {}".format(error), file=sys.stderr)
        return 2
    return 2
