#!/usr/bin/env python3
"""Offline reader for the attribution inventory.

Reads resources.json (and optionally the generator's url-checks.json), prints
summaries, and refuses to display free-text that asserts permission: the
inventory records what committed metadata SAYS, and this reader keeps that
boundary visible. Verbatim license quotes (e.g. MIT's "Permission is hereby
granted") are observational and always allowed.

Usage:
    reader.py resources.json summary
    reader.py resources.json unknowns
    reader.py resources.json resource <id>
    reader.py resources.json summary --url-checks url-checks.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# Phrases that would turn an observation into a permission claim. Matched
# case-insensitively against free-text statement/notes fields only — never
# against noticeReference quotes, which are verbatim file content.
FORBIDDEN_CLAIMS = [
    "approved by",
    "permission is granted",
    "you may reuse",
    "licensed for reuse",
    "cleared for use",
    "authorized by",
    "we have permission",
    "usage approved",
    "granted permission",
    "redistribution permitted",
]

SUMMARY_PATH = Path(__file__).resolve().parent / "schema" / "resources.schema.json"


def _load(path: str) -> Dict[str, Any]:
    with open(path, encoding="utf-8") as handle:
        document = json.load(handle)
    if document.get("schema") != "schema/resources.schema.json":
        raise SystemExit("not an attribution inventory: unexpected schema reference")
    return document


def _guard(document: Dict[str, Any]) -> None:
    """Refuse to print a document whose free text asserts permission."""
    for resource in document.get("resources", []):
        for field in ("statement", "notes"):
            text = str(resource.get("attribution", {}).get(field)
                       if field == "statement" else resource.get("notes", "") or "")
            lowered = text.lower()
            for phrase in FORBIDDEN_CLAIMS:
                if phrase in lowered:
                    raise SystemExit(
                        "refusing to display {!r}: free text asserts permission ({!r}); "
                        "edit the inventory to state what committed metadata says instead".format(
                            resource.get("id", "?"), phrase))


def _counts(document: Dict[str, Any]) -> Dict[str, int]:
    counts = {"verified": 0, "secondary": 0, "unknown": 0}
    for resource in document.get("resources", []):
        state = resource["reuse"]["evidenceState"]
        counts[state] = counts.get(state, 0) + 1
    return counts


def cmd_summary(document: Dict[str, Any], url_checks: Optional[Dict[str, Any]]) -> None:
    counts = _counts(document)
    print("resources: {}".format(len(document.get("resources", []))))
    print("reuse evidence: verified={}, secondary={}, unknown={}".format(
        counts["verified"], counts["secondary"], counts["unknown"]))
    print("repo: {}  branch: {}  baseRevision: {}".format(
        document.get("repo", "?"), document.get("branch", "?"),
        document.get("baseRevision", "?")))
    print("derived from {} committed sources".format(len(document.get("sources", []))))
    if url_checks:
        results = url_checks.get("results", [])
        reachable = sum(1 for r in results if r.get("reachability") == "reachable")
        unreachable = sum(1 for r in results if r.get("reachability") == "unreachable")
        print("url checks: {} reachable, {} unreachable (evidence describes "
              "reachability, never permission)".format(reachable, unreachable))
    print("(evidence states describe what was observed, never permission)")


def cmd_unknowns(document: Dict[str, Any]) -> None:
    unknowns = [r for r in document.get("resources", [])
                if r["reuse"]["evidenceState"] == "unknown"]
    if not unknowns:
        print("no resources with unknown reuse evidence")
        return
    print("resources with no committed reuse notice ({}):".format(len(unknowns)))
    for resource in unknowns:
        print("  - {} ({}): {}".format(
            resource["id"], resource["sourceGroup"], resource["notes"]))


def cmd_resource(document: Dict[str, Any], resource_id: str) -> None:
    for resource in document.get("resources", []):
        if resource["id"] == resource_id:
            print(json.dumps(resource, indent=2, sort_keys=True))
            return
    raise SystemExit("no resource with id {!r}".format(resource_id))


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="reader.py", description=__doc__)
    parser.add_argument("inventory", help="path to resources.json")
    parser.add_argument("command", choices=["summary", "unknowns", "resource"])
    parser.add_argument("resource_id", nargs="?", default=None)
    parser.add_argument("--url-checks", default=None,
                        help="optional url-checks.json produced by inventory.py --verify-urls")
    args = parser.parse_args(argv[1:] if argv is not None else sys.argv[1:])

    document = _load(args.inventory)
    _guard(document)

    url_checks = None
    if args.url_checks:
        with open(args.url_checks, encoding="utf-8") as handle:
            url_checks = json.load(handle)

    if args.command == "summary":
        cmd_summary(document, url_checks)
    elif args.command == "unknowns":
        cmd_unknowns(document)
    elif args.command == "resource":
        if not args.resource_id:
            parser.error("resource command requires a resource id")
        cmd_resource(document, args.resource_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
