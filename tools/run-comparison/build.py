"""Build the static run-comparison view from synthetic saved reports.

    python tools/run-comparison/build.py --fixtures <dir-or-file>... \
        --out <directory> [--replay]

Reads every ``*.json`` fixture with report_reader; reports the reader
refused are excluded and listed with their recorded reasons. The
compared pair is the first two accepted reports in sorted order — the
view states that choice. Everything rendered is derived from the
reports: nothing is measured, fetched or invented at view time. The
HTML has no script, no animation, no transitions and no external
resources, so reduced-motion preferences are trivially honored.

With ``--replay`` the run becomes a validate-before-write gate: the
artifacts already in the output directory are validated against a fresh
derivation of the same fixtures before anything is written, and any
disagreement is reported and exits nonzero with the existing evidence
preserved byte-for-byte. ``--force`` is the single deliberate path to
regenerate disagreeing evidence. The replay receipt binds the view and
the receipt to the exact fixture-input digests, the generator sources
and each other's bytes, so stale evidence is detectable, never silent.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from report_reader import ReadReport as Report, read_report

# --------------------------------------------------------------------------
# pair analysis
# --------------------------------------------------------------------------


def _fmt(value: float, precision: int) -> str:
    return "{:.{}f}".format(value, precision)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _benchmark_text(dataset: Any) -> str:
    if dataset.benchmark_id is None:
        return "an unrecorded benchmark"
    if dataset.benchmark_version is None:
        return "{!r} (version unrecorded)".format(dataset.benchmark_id)
    return "{!r} v{}".format(dataset.benchmark_id, dataset.benchmark_version)


def _weights_text(weights: Any) -> str:
    if not weights:
        return "none recorded"
    return ", ".join(weights)


def source_verdict(a: Report, b: Report) -> Dict[str, str]:
    """Whether the two runs' source identity supports a comparison.

    Pinning is checked first: a commit sha on a dirty working tree pins
    nothing, so until both sides pin the bytes that ran, no claim of same
    or changed source is supportable.
    """

    sa, sb = a.source, b.source
    if not (sa.pins_the_scored_bytes and sb.pins_the_scored_bytes):
        sides = " and ".join(
            name
            for name, report in (("run A", a), ("run B", b))
            if not report.source.pins_the_scored_bytes
        )
        return {
            "verdict": "unknown",
            "detail": (
                "the source bytes cannot be pinned: on {} the working tree was "
                "dirty or no commit sha was recorded, so nothing pins what ran".format(sides)
            ),
        }
    if sa.repository is None or sb.repository is None:
        sides = " and ".join(
            name
            for name, report in (("run A", a), ("run B", b))
            if report.source.repository is None
        )
        return {
            "verdict": "unknown",
            "detail": (
                "the repository is not recorded on {} — the runs cannot be "
                "shown to come from the same source".format(sides)
            ),
        }
    if sa.repository != sb.repository:
        return {
            "verdict": "changed",
            "detail": "different repositories, both pinned: {!r} vs {!r}".format(
                sa.repository, sb.repository
            ),
        }
    if sa.sha != sb.sha:
        return {
            "verdict": "changed",
            "detail": "different commits: {} vs {}".format(sa.sha[:12], sb.sha[:12]),
        }
    return {
        "verdict": "same",
        "detail": "same repository and commit ({})".format(sa.sha[:12]),
    }


def _version_verdict(field: str, va: Any, vb: Any) -> Dict[str, str]:
    if va is None or vb is None:
        return {
            "verdict": "unknown",
            "detail": "{} is not recorded on at least one side".format(field),
        }
    if va != vb:
        return {"verdict": "changed", "detail": "{}: {!r} vs {!r}".format(field, va, vb)}
    return {
        "verdict": "same",
        "detail": "{} matches on both sides ({!r})".format(field, va),
    }


def scorer_verdict(a: Report, b: Report) -> Dict[str, str]:
    checks = [
        _version_verdict(
            "contract", a.scorer.contract_version, b.scorer.contract_version
        ),
        _version_verdict("sdk", a.scorer.sdk_version, b.scorer.sdk_version),
        _version_verdict(
            "plugin", a.scorer.plugin_version, b.scorer.plugin_version
        ),
    ]
    if any(check["verdict"] == "changed" for check in checks):
        detail = "; ".join(
            check["detail"] for check in checks if check["verdict"] != "same"
        )
        return {
            "verdict": "changed",
            "detail": (
                detail
                + " — what a metric's role and direction mean cannot be "
                "assumed to carry over"
            ),
        }
    if any(check["verdict"] == "unknown" for check in checks):
        detail = "; ".join(
            check["detail"] for check in checks if check["verdict"] == "unknown"
        )
        return {"verdict": "unknown", "detail": detail}
    return {
        "verdict": "same",
        "detail": "contract, sdk and plugin versions all match ({}, {}, {})".format(
            a.scorer.contract_version, a.scorer.sdk_version, a.scorer.plugin_version
        ),
    }


def dataset_verdict(a: Report, b: Report) -> Dict[str, Any]:
    fields: List[Dict[str, str]] = []

    if (
        a.dataset.benchmark_id != b.dataset.benchmark_id
        or a.dataset.benchmark_version != b.dataset.benchmark_version
    ):
        fields.append(
            {
                "field": "benchmark",
                "verdict": "changed",
                "detail": "{} vs {} — not the same benchmark".format(
                    _benchmark_text(a.dataset), _benchmark_text(b.dataset)
                ),
            }
        )
    else:
        # Matching id and version are labels, not bytes. The writer's
        # contract records no dataset digest and no benchmark commit, so
        # nothing in a report binds the scored case set to bytes; until a
        # report actually records such a binding, matching labels stay
        # unknown and the pair stays incomparable.
        fields.append(
            {
                "field": "benchmark",
                "verdict": "unknown",
                "detail": (
                    "both runs record the same benchmark label ({}, id "
                    "{!r}), but neither report records a byte-level "
                    "binding of the dataset itself - no dataset digest "
                    "and no pinned benchmark commit - so matching labels "
                    "alone cannot show the runs scored the same case set".format(
                        _benchmark_text(a.dataset), a.dataset.benchmark_id
                    )
                ),
            }
        )

    ca, cb = a.dataset.command, b.dataset.command
    if ca is None or cb is None:
        sides = " and ".join(
            name
            for name, value in (("run A", ca), ("run B", cb))
            if value is None
        )
        fields.append(
            {
                "field": "case set (command)",
                "verdict": "unknown",
                "detail": (
                    "the producing command is not recorded on {} — the runs "
                    "cannot be shown to share a case set".format(sides)
                ),
            }
        )
    elif ca != cb:
        fields.append(
            {
                "field": "case set (command)",
                "verdict": "changed",
                "detail": "`{}` vs `{}` — the runs scored different case sets".format(
                    ca, cb
                ),
            }
        )
    else:
        fields.append(
            {
                "field": "case set (command)",
                "verdict": "same",
                "detail": "both runs were produced by `{}`".format(ca),
            }
        )

    wa, wb = a.dataset.weights_used, b.dataset.weights_used
    if wa is None or wb is None:
        sides = " and ".join(
            name
            for name, value in (("run A", wa), ("run B", wb))
            if value is None
        )
        fields.append(
            {
                "field": "weights",
                "verdict": "unknown",
                "detail": (
                    "the used weights are not recorded on {} (the report may "
                    "predate weight recording)".format(sides)
                ),
            }
        )
    elif sorted(wa) != sorted(wb):
        fields.append(
            {
                "field": "weights",
                "verdict": "changed",
                "detail": "{} vs {} — the runs did not use the same weights".format(
                    _weights_text(wa), _weights_text(wb)
                ),
            }
        )
    elif not wa:
        fields.append(
            {
                "field": "weights",
                "verdict": "same",
                "detail": "neither run used recorded weights",
            }
        )
    else:
        capture_a = a.dataset.weights_uploaded
        capture_b = b.dataset.weights_uploaded
        if capture_a is None or capture_b is None:
            sides = " and ".join(
                name
                for name, capture in (("run A", capture_a), ("run B", capture_b))
                if capture is None
            )
            fields.append(
                {
                    "field": "weights",
                    "verdict": "unknown",
                    "detail": (
                        "the byte identity of the used weights ({}) cannot be "
                        "shown to match: weight capture is not recorded on {} "
                        "(weightsUploaded absent or null — the report may "
                        "predate capture)".format(_weights_text(wa), sides)
                    ),
                }
            )
        else:
            index_a = {receipt.path: receipt for receipt in capture_a}
            index_b = {receipt.path: receipt for receipt in capture_b}
            byte_differences: List[str] = []
            unreceipted: List[str] = []
            for used_path in sorted(wa):
                receipt_a = index_a.get(used_path)
                receipt_b = index_b.get(used_path)
                if receipt_a is None or receipt_b is None:
                    if receipt_a is None and receipt_b is None:
                        missing = "run A and run B"
                    else:
                        missing = "run A" if receipt_a is None else "run B"
                    unreceipted.append(
                        "{}: no capture receipt names it on {}".format(
                            used_path, missing
                        )
                    )
                elif (
                    receipt_a.sha256 != receipt_b.sha256
                    or receipt_a.size != receipt_b.size
                ):
                    byte_differences.append(
                        "{}: sha256 {} ({} bytes) vs {} ({} bytes)".format(
                            used_path,
                            receipt_a.sha256[:12],
                            receipt_a.size,
                            receipt_b.sha256[:12],
                            receipt_b.size,
                        )
                    )
            if byte_differences:
                fields.append(
                    {
                        "field": "weights",
                        "verdict": "changed",
                        "detail": (
                            "the recorded weight bytes differ: "
                            + "; ".join(byte_differences)
                        ),
                    }
                )
            elif unreceipted:
                fields.append(
                    {
                        "field": "weights",
                        "verdict": "unknown",
                        "detail": (
                            "the byte identity of the used weights ({}) is "
                            "partly unrecorded: {}".format(
                                _weights_text(wa), "; ".join(unreceipted)
                            )
                        ),
                    }
                )
            else:
                fields.append(
                    {
                        "field": "weights",
                        "verdict": "same",
                        "detail": (
                            "same weight paths with identical recorded bytes "
                            "(sha256 and size): {}".format(_weights_text(wa))
                        ),
                    }
                )

    floors_a = {m.key: m for m in a.metrics if m.role == "floor"}
    floors_b = {m.key: m for m in b.metrics if m.role == "floor"}
    floor_keys = sorted(set(floors_a) | set(floors_b))
    if not floor_keys:
        fields.append(
            {
                "field": "scoring floors",
                "verdict": "same",
                "detail": "no floor metrics are recorded on either side",
            }
        )
    else:
        floor_parts: List[str] = []
        floors_verdict = "same"
        for key in floor_keys:
            metric_a = floors_a.get(key)
            metric_b = floors_b.get(key)
            if metric_a is None or metric_b is None:
                if metric_a is None and metric_b is None:
                    side = "neither run"
                else:
                    side = "run A" if metric_b is None else "run B"
                floor_parts.append("{}: recorded on {} only".format(key, side))
                if floors_verdict == "same":
                    floors_verdict = "unknown"
            elif (metric_a.value, metric_a.precision) != (
                metric_b.value,
                metric_b.precision,
            ):
                floor_parts.append(
                    "{}: {} on run A vs {} on run B — the scored metric's "
                    "floor changed between the runs".format(
                        key,
                        _fmt(metric_a.value, metric_a.precision),
                        _fmt(metric_b.value, metric_b.precision),
                    )
                )
                floors_verdict = "changed"
            elif (
                metric_a.unit,
                metric_a.higher_is_better,
                metric_a.relates_to,
            ) != (
                metric_b.unit,
                metric_b.higher_is_better,
                metric_b.relates_to,
            ):
                floor_parts.append(
                    "{}: same value {} but the floor's identity (unit, "
                    "direction, reference) differs between the runs".format(
                        key, _fmt(metric_a.value, metric_a.precision)
                    )
                )
                floors_verdict = "changed"
            else:
                floor_parts.append(
                    "{}: {} on both runs".format(
                        key, _fmt(metric_a.value, metric_a.precision)
                    )
                )
        prefix = {
            "changed": "the scoring floors differ: ",
            "unknown": "the scoring floors cannot be shown to match: ",
            "same": "",
        }[floors_verdict]
        fields.append(
            {
                "field": "scoring floors",
                "verdict": floors_verdict,
                "detail": prefix + "; ".join(floor_parts),
            }
        )

    verdict = "same"
    if any(item["verdict"] == "changed" for item in fields):
        verdict = "changed"
    elif any(item["verdict"] == "unknown" for item in fields):
        verdict = "unknown"
    summary = {
        "same": "benchmark, case set, weight bytes and scoring floors line up on every recorded axis",
        "changed": "at least one dataset axis changed — see the field verdicts",
        "unknown": (
            "at least one dataset axis is unrecorded or unproven — the runs "
            "cannot be shown to share conditions"
        ),
    }[verdict]
    return {"verdict": verdict, "detail": summary, "fields": fields}


def _metric_identity(metric: Any) -> Tuple[Any, ...]:
    return (
        metric.unit,
        metric.higher_is_better,
        metric.role,
        metric.precision,
        metric.relates_to,
    )


def _floor_unit_suffix(item: Dict[str, Any]) -> str:
    # The unit is part of a floor's identity: when the two runs recorded
    # different units, the view says so instead of silently showing one.
    a, b = item["unit_a"], item["unit_b"]
    if a != b:
        return " · unit differs: run A {} vs run B {}".format(
            a or "unrecorded", b or "unrecorded"
        )
    return " · " + a if a else ""


def _floor_relates_text(item: Dict[str, Any]) -> str:
    if item.get("one_sided"):
        return (
            "{} records this metric as a scoring floor; "
            "the other run does not".format(item["one_sided"])
        )
    a = item["relates_to_a"]
    b = item["relates_to_b"]
    if a == b:
        return "floor of " + a if a else ""
    return "run A floor of {} / run B floor of {}".format(
        a or "nothing", b or "nothing"
    )


def metric_sections(
    a: Report, b: Report, comparable: bool
) -> Dict[str, List[Dict[str, Any]]]:
    a_by_key = {metric.key: metric for metric in a.metrics}
    b_by_key = {metric.key: metric for metric in b.metrics}
    shared: List[Dict[str, Any]] = []
    context: List[Dict[str, Any]] = []
    for key in sorted(set(a_by_key) & set(b_by_key)):
        ma, mb = a_by_key[key], b_by_key[key]
        if (ma.role == "floor") != (mb.role == "floor"):
            # One side records this metric as a scoring floor and the
            # other does not: state that per side instead of comparing
            # the two as if they were the same kind of entry.
            value_differs = (ma.value, ma.precision) != (
                mb.value,
                mb.precision,
            )
            context.append(
                {
                    "key": key,
                    "label": (ma if ma.role == "floor" else mb).label or key,
                    "value_a": _fmt(ma.value, ma.precision),
                    "value_b": _fmt(mb.value, mb.precision),
                    "unit_a": ma.unit or "",
                    "unit_b": mb.unit or "",
                    "relates_to_a": ma.relates_to or "",
                    "relates_to_b": mb.relates_to or "",
                    "differs": True,
                    "value_differs": value_differs,
                    "identity_differs": True,
                    "one_sided": "run A" if ma.role == "floor" else "run B",
                }
            )
            continue
        if ma.role == "floor" and mb.role == "floor":
            # A floor is not "the same floor" unless its identity - unit,
            # direction, and the metric it references - matches too;
            # comparing values alone hides a changed floor wearing the
            # same number.
            value_differs = (ma.value, ma.precision) != (
                mb.value,
                mb.precision,
            )
            identity_differs = (
                ma.unit,
                ma.higher_is_better,
                ma.relates_to,
            ) != (mb.unit, mb.higher_is_better, mb.relates_to)
            context.append(
                {
                    "key": key,
                    "label": ma.label or key,
                    "value_a": _fmt(ma.value, ma.precision),
                    "value_b": _fmt(mb.value, mb.precision),
                    "unit_a": ma.unit or "",
                    "unit_b": mb.unit or "",
                    "relates_to_a": ma.relates_to or "",
                    "relates_to_b": mb.relates_to or "",
                    "differs": value_differs or identity_differs,
                    "value_differs": value_differs,
                    "identity_differs": identity_differs,
                }
            )
            continue
        row: Dict[str, Any] = {
            "key": key,
            "label": ma.label or key,
            "primary": bool(ma.primary or mb.primary),
            "run_a": _fmt(ma.value, ma.precision),
            "run_b": _fmt(mb.value, mb.precision),
            "unit": ma.unit,
            "direction": (
                "lower is better" if not ma.higher_is_better else "higher is better"
            ),
        }
        if not comparable:
            row["delta"] = None
            row["delta_note"] = "not compared — the runs' conditions do not line up"
        elif _metric_identity(ma) != _metric_identity(mb):
            row["delta"] = None
            row["delta_note"] = (
                "not compared — the metric's identity (unit, direction, role, "
                "precision or floor reference) differs between the runs"
            )
        else:
            row["delta"] = "{:+.{}f}".format(mb.value - ma.value, ma.precision)
            row["delta_note"] = row["direction"]
        shared.append(row)
    only_a = [
        {
            "key": metric.key,
            "label": metric.label or metric.key,
            "value": _fmt(metric.value, metric.precision),
            "unit": metric.unit,
        }
        for metric in a.metrics
        if metric.key not in b_by_key
    ]
    only_b = [
        {
            "key": metric.key,
            "label": metric.label or metric.key,
            "value": _fmt(metric.value, metric.precision),
            "unit": metric.unit,
        }
        for metric in b.metrics
        if metric.key not in a_by_key
    ]
    return {
        "shared": shared,
        "context": context,
        "only_in_a": only_a,
        "only_in_b": only_b,
    }


def analyze_pair(a: Report, b: Report) -> Dict[str, Any]:
    source = source_verdict(a, b)
    dataset = dataset_verdict(a, b)
    scorer = scorer_verdict(a, b)
    comparable = (
        source["verdict"] in ("same", "changed")
        and dataset["verdict"] == "same"
        and scorer["verdict"] == "same"
    )
    blockers: List[str] = []
    if source["verdict"] == "unknown":
        blockers.append(
            "source identity does not pin what ran: " + source["detail"]
        )
    if dataset["verdict"] != "same":
        blockers.append(
            "dataset conditions "
            + ("changed" if dataset["verdict"] == "changed" else "cannot be shown to match")
            + ": see the field verdicts"
        )
    if scorer["verdict"] != "same":
        blockers.append(
            "scorer identity "
            + ("changed" if scorer["verdict"] == "changed" else "is partly unrecorded")
            + ": "
            + scorer["detail"]
        )
    sections = metric_sections(a, b, comparable)
    findings: List[str] = []
    if comparable:
        findings.append(
            "All recorded conditions match: source, dataset (benchmark, case "
            "set, weight bytes, scoring floors) and scorer identity."
        )
        findings.append(
            "The metric deltas below are observations only; this view states "
            "no cause for any difference."
        )
    else:
        findings.extend(blockers)
        findings.append(
            "While any blocker stands, a metric difference is not evidence "
            "of a source effect."
        )
    return {
        "comparable": comparable,
        "conditions": {"source": source, "dataset": dataset, "scorer": scorer},
        "blockers": blockers,
        "findings": findings,
        **sections,
    }


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------

_CSS = """.premise { background: #f6f8fa; padding: .75rem 1rem; border-radius: 6px; }
.ok { background: #eaf7ee; color: #116329; padding: .75rem 1rem; border-radius: 6px; }
.banner { background: #ffe5e0; color: #a40e26; padding: .75rem 1rem; border-radius: 6px; }
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1rem; background: #ffffff; color: #1f2328; line-height: 1.55; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
h2 { font-size: 1.125rem; margin-top: 2rem; padding-bottom: .25rem; border-bottom: 1px solid #d0d7de; }
h3 { font-size: 1rem; margin: 1rem 0 .25rem; }
p, li { font-size: .95rem; }
table { width: 100%; margin: .75rem 0; border-collapse: collapse; }
th, td { padding: .5rem .6rem; border-bottom: 1px solid #d0d7de; text-align: left; vertical-align: top; font-size: .9rem; }
th[scope=row] { white-space: nowrap; font-weight: 600; }
thead th { font-weight: 600; }
.chip { display: inline-block; padding: 0 .5rem; border-radius: 999px; font-size: .8125rem; font-weight: 600; }
.chip-same { color: #116329; background: #d7f5dd; }
.chip-changed { color: #7d4e00; background: #ffe9a8; }
.chip-unknown { color: #444d56; background: #e2e8f0; }
.muted { color: #57606a; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #d0d7de; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .875em; }
@media (max-width: 48rem) { body { padding: 1rem .75rem; } th, td { padding: .4rem .45rem; } }"""

_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Run comparison — offline workbench</title>
<style>
__CSS__
</style>
</head>
<body>
<main>
__HEAD__
<h2>Conditions between the two runs</h2>
<table>
<thead><tr><th scope="col">Axis</th><th scope="col">Verdict</th><th scope="col">Detail</th></tr></thead>
<tbody>
__CONDITIONS__
</tbody>
</table>
__BANNER__
<h2>Metric comparison</h2>
<table>
<thead><tr><th scope="col">Metric</th><th scope="col">Run A (__FA__)</th><th scope="col">Run B (__FB__)</th><th scope="col">Difference</th></tr></thead>
<tbody>
__METRICS__
</tbody>
</table>
<h2>Floor context</h2>
__CONTEXT__
<h2>Metrics without a counterpart</h2>
__UNSHARED__
<h2>Reports excluded from this comparison</h2>
__EXCLUDED__
<h2>Recorded provenance</h2>
<table>
<thead><tr><th scope="col">Field</th><th scope="col">Run A (__FA__)</th><th scope="col">Run B (__FB__)</th></tr></thead>
<tbody>
__PROVENANCE__
</tbody>
</table>
<h2>Recorded diagnostics</h2>
__DIAGNOSTICS__
<footer><p>Generated offline by <code>tools/run-comparison/build.py</code> from the synthetic fixture matrix — nothing measured, fetched or invented at view time. The page contains no animation, transition or script, so reduced-motion preferences need no accommodation.</p></footer>
</main>
</body>
</html>
"""


def _esc(value: Any) -> str:
    return html.escape(str(value))


def _chip(verdict: str) -> str:
    return '<span class="chip chip-{v}">{v}</span>'.format(v=_esc(verdict))


def render(
    a: Report,
    b: Report,
    a_name: str,
    b_name: str,
    analysis: Dict[str, Any],
    excluded: List[Dict[str, Any]],
    pair_note: str,
) -> str:
    conditions = analysis["conditions"]
    condition_rows = []
    for axis in ("source", "dataset", "scorer"):
        verdict = conditions[axis]
        fields_html = ""
        if "fields" in verdict:
            fields_html = "<ul>" + "".join(
                '<li data-field="{binding}" data-verdict="{verdict}"><strong>{field_label}</strong> {chip} — {detail}</li>'.format(
                    binding=_esc(axis + "." + field["field"]),
                    verdict=_esc(field["verdict"]),
                    field_label=_esc(field["field"]),
                    chip=_chip(field["verdict"]),
                    detail=_esc(field["detail"]),
                )
                for field in verdict["fields"]
            ) + "</ul>"
        condition_rows.append(
            '<tr data-axis="{axis}" data-verdict="{verdict}"><th scope="row">{axis_label}</th><td>{chip}</td><td>{detail}{fields}</td></tr>'.format(
                axis=axis,
                verdict=_esc(verdict["verdict"]),
                axis_label=_esc(axis),
                chip=_chip(verdict["verdict"]),
                detail=_esc(verdict["detail"]),
                fields=fields_html,
            )
        )
    conditions_html = "\n".join(condition_rows)

    if analysis["comparable"]:
        banner = (
            '<p class="ok">Conditions line up on every axis the reports record. '
            "The deltas below are observations only — this view states no "
            "cause for any difference.</p>"
        )
    else:
        banner = (
            '<p class="banner"><strong>Not comparable as conditions stand.</strong> '
            + _esc("; ".join(analysis["blockers"]))
            + "</p>"
        )

    metric_rows = []
    for row in analysis["shared"]:
        marker = ' <span class="muted">(primary)</span>' if row["primary"] else ""
        sub = _esc(row["key"]) + (
            " · " + _esc(row["unit"]) if row["unit"] else ""
        )
        if row["delta"] is None:
            delta_cell = '<span class="muted">— not compared</span><br> <span class="muted">{}</span>'.format(
                _esc(row["delta_note"])
            )
        else:
            delta_cell = '<strong>{}</strong><br> <span class="muted">{}</span>'.format(
                _esc(row["delta"]), _esc(row["delta_note"])
            )
        metric_rows.append(
            '<tr data-metric-key="{key}"><td><strong>{label}</strong>{marker}<br>'
            '<span class="muted">{sub}</span></td>'
            "<td>{va}</td><td>{vb}</td><td>{delta}</td></tr>".format(
                key=_esc(row["key"]),
                label=_esc(row["label"]),
                marker=marker,
                sub=sub,
                va=_esc(row["run_a"]),
                vb=_esc(row["run_b"]),
                delta=delta_cell,
            )
        )
    metrics_html = "\n".join(metric_rows) or (
        '<p class="muted">No shared non-floor metrics.</p>'
    )

    if analysis["context"]:
        context_rows = "\n".join(
            '<tr data-floor-key="{key}"><td><strong>{label}</strong><br>'
            '<span class="muted">{key_sub}</span></td><td>{value_a}</td><td>{value_b}</td><td>{relates}{diff_chip}</td></tr>'.format(
                key=_esc(item["key"]),
                label=_esc(item["label"]),
                key_sub=_esc(item["key"] + _floor_unit_suffix(item)),
                value_a=_esc(item["value_a"]),
                value_b=_esc(item["value_b"]),
                relates=(
                    _esc(_floor_relates_text(item))
                    if _floor_relates_text(item)
                    else '<span class="muted">floor reference</span>'
                ),
                diff_chip=(
                    (
                        ' <span class="chip chip-changed">value differs between the runs</span>'
                        if item["value_differs"]
                        else ""
                    )
                    + (
                        ' <span class="chip chip-changed">floor identity differs between the runs</span>'
                        if item["identity_differs"]
                        else ""
                    )
                ),
            )
            for item in analysis["context"]
        )
        context_html = (
            "<p>Floors are reference values, not findings, so they carry no "
            "difference column; both runs' values are shown.</p>\n"
            '<table><thead><tr><th scope="col">Metric</th>'
            '<th scope="col">Run A ({fa})</th><th scope="col">Run B ({fb})</th>'
            '<th scope="col">Reference for</th></tr></thead><tbody>\n'
            + context_rows
            + "\n</tbody></table>"
        ).format(fa=_esc(a_name), fb=_esc(b_name))
    else:
        context_html = '<p class="muted">No floor metrics recorded.</p>'

    def _unshared(items: List[Dict[str, Any]]) -> str:
        if not items:
            return '<p class="muted">None.</p>'
        return "<ul>" + "".join(
            "<li><strong>{}</strong> — {}{}</li>".format(
                _esc(item["label"]),
                _esc(item["value"]),
                (" " + _esc(item["unit"])) if item["unit"] else "",
            )
            for item in items
        ) + "</ul>"

    unshared_html = "<h3>Only in {}</h3>{}<h3>Only in {}</h3>{}".format(
        _esc(a_name),
        _unshared(analysis["only_in_a"]),
        _esc(b_name),
        _unshared(analysis["only_in_b"]),
    )

    if excluded:
        excluded_html = (
            "<p>The reader refused these fixture files; they are recorded here "
            "instead of being compared.</p>\n<ul>\n"
            + "\n".join(
                "<li><strong>{}</strong><ul>{}</ul></li>".format(
                    _esc(item["file"]),
                    "".join(
                        "<li><code>{}</code></li>".format(_esc(reason))
                        for reason in item["reasons"]
                    ),
                )
                for item in excluded
            )
            + "\n</ul>"
        )
    else:
        excluded_html = '<p class="muted">No fixture file was refused.</p>'

    def _source_cell(report: Report) -> str:
        if report.source.sha is None:
            return "not recorded"
        pins = (
            "pins the scored bytes"
            if report.source.pins_the_scored_bytes
            else "does not pin the scored bytes (dirty tree)"
        )
        return "{} — {}".format(report.source.sha[:12], pins)

    def _capture_text(report: Report) -> str:
        capture = report.dataset.weights_uploaded
        if capture is None:
            return "not recorded — the report may predate weight capture"
        if not capture:
            return "recorded: nothing was uploaded"
        return "; ".join(
            "{} ({} bytes, sha256 {})".format(
                receipt.path, receipt.size, receipt.sha256[:12]
            )
            for receipt in capture
        )

    def _diag(report: Report) -> str:
        if not report.diagnostics:
            return '<p class="muted">None recorded.</p>'
        return "<ul>" + "".join(
            "<li>{}</li>".format(_esc(line)) for line in report.diagnostics
        ) + "</ul>"

    prov_rows = []
    for label, va, vb in [
        ("Report ID", a.report_id, b.report_id),
        ("Repository", a.source.repository, b.source.repository),
        ("Commit", _source_cell(a), _source_cell(b)),
        ("Benchmark", _benchmark_text(a.dataset), _benchmark_text(b.dataset)),
        (
            "Case set (command)",
            "`{}`".format(a.dataset.command)
            if a.dataset.command is not None
            else "not recorded",
            "`{}`".format(b.dataset.command)
            if b.dataset.command is not None
            else "not recorded",
        ),
        (
            "Weights used",
            _weights_text(a.dataset.weights_used)
            if a.dataset.weights_used is not None
            else "not recorded — may predate weight recording",
            _weights_text(b.dataset.weights_used)
            if b.dataset.weights_used is not None
            else "not recorded — may predate weight recording",
        ),
        ("Weight capture", _capture_text(a), _capture_text(b)),
        (
            "Contract",
            a.scorer.contract_version or "not recorded",
            b.scorer.contract_version or "not recorded",
        ),
        ("SDK", a.scorer.sdk_version or "not recorded", b.scorer.sdk_version or "not recorded"),
        (
            "Plugin",
            a.scorer.plugin_version or "not recorded",
            b.scorer.plugin_version or "not recorded",
        ),
    ]:
        prov_rows.append(
            '<tr><th scope="row">{}</th><td>{}</td><td>{}</td></tr>'.format(
                _esc(label), _esc(va), _esc(vb)
            )
        )
    provenance_html = "\n".join(prov_rows)

    diagnostics_html = "<h3>{}</h3>{}<h3>{}</h3>{}".format(
        _esc(a_name), _diag(a), _esc(b_name), _diag(b)
    )

    findings_html = (
        "<ul>"
        + "".join("<li>{}</li>".format(_esc(line)) for line in analysis["findings"])
        + "</ul>"
    )
    head = (
        "<h1>Run comparison</h1>"
        "<h2>Findings</h2>"
        + findings_html
        + '<p class="premise"><strong>Premise.</strong> A comparison is warranted '
        "only where the two runs line up on source, dataset, scorer and metric "
        "identity — the verdicts below state exactly where they do, and unknown "
        "provenance blocks a conclusion instead of being filled in. Both reports "
        "are synthetic fixture outputs built offline: no network access, no "
        "student data.</p>"
        "<p>{}</p>".format(_esc(pair_note))
    )

    page = _TEMPLATE
    for token, value in [
        ("__CSS__", _CSS),
        ("__HEAD__", head),
        ("__CONDITIONS__", conditions_html),
        ("__BANNER__", banner),
        ("__FA__", _esc(a_name)),
        ("__FB__", _esc(b_name)),
        ("__METRICS__", metrics_html),
        ("__CONTEXT__", context_html),
        ("__UNSHARED__", unshared_html),
        ("__EXCLUDED__", excluded_html),
        ("__PROVENANCE__", provenance_html),
        ("__DIAGNOSTICS__", diagnostics_html),
    ]:
        page = page.replace(token, value)
    return page


# --------------------------------------------------------------------------
# receipt
# --------------------------------------------------------------------------


def build_sections(
    a: Report,
    b: Report,
    a_name: str,
    b_name: str,
    analysis: Dict[str, Any],
    excluded: List[Dict[str, Any]],
    pair_note: str,
) -> Dict[str, List[str]]:
    lines: Dict[str, List[str]] = {
        "pair": [pair_note],
        "conditions": [],
        "metric_comparison": [],
        "floor_context": [],
        "unshared": [],
        "excluded": [],
    }
    for axis in ("source", "dataset", "scorer"):
        verdict = analysis["conditions"][axis]
        lines["conditions"].append(
            "{}: {} — {}".format(axis, verdict["verdict"], verdict["detail"])
        )
        for field in verdict.get("fields", []):
            lines["conditions"].append(
                "  {}.{}: {} — {}".format(
                    axis, field["field"], field["verdict"], field["detail"]
                )
            )
    if analysis["comparable"]:
        lines["conditions"].append("pair comparable: yes")
    else:
        lines["conditions"].append(
            "pair comparable: no — " + "; ".join(analysis["blockers"])
        )
    for row in analysis["shared"]:
        if row["delta"] is None:
            lines["metric_comparison"].append(
                "{}: {} vs {} — {}".format(
                    row["key"], row["run_a"], row["run_b"], row["delta_note"]
                )
            )
        else:
            lines["metric_comparison"].append(
                "{}: {} vs {} ({} — {})".format(
                    row["key"],
                    row["run_a"],
                    row["run_b"],
                    row["delta"],
                    row["delta_note"],
                )
            )
    for item in analysis["context"]:
        lines["floor_context"].append(
            "{} (floor reference: run A {} / run B {}): run A {} vs run B {}{}".format(
                item["key"],
                item["relates_to_a"] or "unspecified",
                item["relates_to_b"] or "unspecified",
                item["value_a"],
                item["value_b"],
                " — differs between the runs" if item["differs"] else "",
            )
        )
    for item in analysis["only_in_a"]:
        lines["unshared"].append(
            "only in {}: {} = {}".format(a_name, item["key"], item["value"])
        )
    for item in analysis["only_in_b"]:
        lines["unshared"].append(
            "only in {}: {} = {}".format(b_name, item["key"], item["value"])
        )
    for item in excluded:
        lines["excluded"].append(
            "{}: {}".format(item["file"], "; ".join(item["reasons"]))
        )
    return lines


def tool_source_digests() -> Dict[str, str]:
    here = Path(__file__).resolve().parent
    return {
        name: _sha((here / name).read_bytes())
        for name in sorted(("build.py", "report_reader.py"))
    }


def make_receipt(
    fixtures_root: str,
    a_name: str,
    b_name: str,
    analysis: Dict[str, Any],
    excluded: List[Dict[str, Any]],
    not_compared: List[Dict[str, str]],
    sections: Dict[str, List[str]],
    html_bytes: bytes,
    inputs: List[Dict[str, str]],
) -> Dict[str, Any]:
    return {
        "generator": "tools/run-comparison/build.py",
        "tool_source": {"files": tool_source_digests()},
        "fixtures_root": fixtures_root,
        "inputs": inputs,
        "compared": [a_name, b_name],
        "not_compared": not_compared,
        "excluded": excluded,
        "pair_comparable": analysis["comparable"],
        "conditions": analysis["conditions"],
        "findings": analysis["findings"],
        "metrics": {
            "shared": analysis["shared"],
            "floors": analysis["context"],
            "only_in_a": analysis["only_in_a"],
            "only_in_b": analysis["only_in_b"],
        },
        "sections": sections,
        "html_sha256": _sha(html_bytes),
    }


# --------------------------------------------------------------------------
# replay gate
# --------------------------------------------------------------------------


REPLAY_GENERATOR = "tools/run-comparison/build.py --replay"


def _json_bytes(payload: Dict[str, Any]) -> bytes:
    """The canonical serialization used for every JSON file build.py writes."""

    return (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")


def replay_gate_disagreements(
    existing: Dict[str, Optional[bytes]],
    fresh_html: bytes,
    fresh_receipt: Dict[str, Any],
    inputs: List[Dict[str, str]],
    tool_source: Dict[str, str],
    compared: List[str],
    expected_replay: Optional[Dict[str, Any]],
) -> List[str]:
    """Validate evidence already on disk against a fresh build.

    ``existing`` maps the artifact roles (view, receipt, replay) to their
    bytes, or None where the file is absent. Returns one line per
    disagreement; an empty list means the existing evidence matches the
    fresh derivation — or nothing exists yet — and rewriting is safe.
    The replay receipt is compared whole against the freshly derived
    expected receipt (generator label, fixture-root binding and full
    structure), so none of its fields can drift silently.
    Nothing here writes or deletes anything: the caller refuses to touch
    the directory while any disagreement stands.
    """

    problems: List[str] = []
    missing = sorted(name for name, data in existing.items() if data is None)
    present = sorted(name for name, data in existing.items() if data is not None)
    if not present:
        return problems
    if missing:
        problems.append(
            "replay disagreement: the evidence directory is in a mixed state "
            "— {} exist but {} are missing; refusing to overwrite partial "
            "evidence".format(", ".join(present), ", ".join(missing))
        )
        return problems

    if existing["view"] != fresh_html:
        problems.append(
            "replay disagreement: the existing view does not match a fresh "
            "build of the same fixtures (existing sha256 {}, fresh {}); it "
            "is preserved and nothing was written".format(
                _sha(existing["view"]), _sha(fresh_html)
            )
        )

    try:
        existing_receipt = json.loads(existing["receipt"].decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        problems.append(
            "replay disagreement: the existing receipt does not parse as "
            "JSON ({})".format(error)
        )
    else:
        if existing_receipt != fresh_receipt:
            problems.append(
                "replay disagreement: the existing receipt does not match a "
                "fresh derivation from the same fixtures and generator "
                "sources (existing sha256 {}, fresh {}); it is preserved "
                "and nothing was written".format(
                    _sha(existing["receipt"]), _sha(_json_bytes(fresh_receipt))
                )
            )

    try:
        existing_replay = json.loads(existing["replay"].decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        problems.append(
            "replay disagreement: the existing replay receipt does not parse "
            "as JSON ({})".format(error)
        )
    else:
        if expected_replay is None:
            problems.append(
                "replay disagreement: no expected replay receipt was "
                "derived to compare against; refusing to write"
            )
        elif existing_replay != expected_replay:
            differing = sorted(
                key
                for key in set(existing_replay) | set(expected_replay)
                if existing_replay.get(key) != expected_replay.get(key)
            )
            problems.append(
                "replay disagreement: the existing replay receipt does not "
                "match the complete expected receipt (generator, "
                "fixture-root binding, digests, inputs, tool source and "
                "compared pair); differing key(s): {}; the existing "
                "receipt is preserved and nothing was written".format(
                    ", ".join(differing) or "structure"
                )
            )
    return problems


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixtures",
        required=True,
        action="append",
        help="a fixture file or a directory of them (repeatable)",
    )
    parser.add_argument("--out", required=True, help="directory for the built view and receipts")
    parser.add_argument(
        "--replay",
        action="store_true",
        help="validate existing artifacts against a fresh build before "
        "writing; refuse and preserve them on any disagreement",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="with --replay: replace existing evidence even when validation "
        "finds a disagreement (deliberate regeneration after a fixture or "
        "tool change)",
    )
    arguments = parser.parse_args()
    if arguments.force and not arguments.replay:
        parser.error("--force is only meaningful with --replay")

    files: List[Path] = []
    roots: List[str] = []
    for item in arguments.fixtures:
        path = Path(item)
        roots.append(path.as_posix())
        if path.is_dir():
            files.extend(sorted(path.glob("*.json")))
        else:
            files.append(path)
    if not files:
        print("no fixture files found", file=sys.stderr)
        return 2

    loaded: List[Tuple[str, Report]] = []
    excluded: List[Dict[str, Any]] = []
    inputs = [
        {"file": path.name, "sha256": _sha(path.read_bytes())} for path in files
    ]
    for path in files:
        report = read_report(path)
        if report.accepted:
            loaded.append((path.name, report))
        else:
            excluded.append(
                {
                    "file": path.name,
                    "reasons": [
                        "{}: {}".format(refusal.code, refusal.detail)
                        for refusal in report.refusals
                    ],
                }
            )
    if len(loaded) < 2:
        print(
            "need at least two accepted reports to compare; found {}".format(
                len(loaded)
            ),
            file=sys.stderr,
        )
        return 2

    (a_name, a), (b_name, b) = loaded[0], loaded[1]
    pair_note = (
        "Compared: {} and {} — the first two accepted reports in sorted order "
        "({} of {} fixture files accepted).".format(
            a_name, b_name, len(loaded), len(files)
        )
    )
    not_compared = [
        {
            "file": name,
            "note": "accepted; only the first two accepted reports form the compared pair",
        }
        for name, _ in loaded[2:]
    ]

    analysis = analyze_pair(a, b)
    html_bytes = render(
        a, b, a_name, b_name, analysis, excluded, pair_note
    ).encode("utf-8")
    sections = build_sections(a, b, a_name, b_name, analysis, excluded, pair_note)
    receipt = make_receipt(
        "; ".join(roots),
        a_name,
        b_name,
        analysis,
        excluded,
        not_compared,
        sections,
        html_bytes,
        inputs,
    )
    receipt_bytes = _json_bytes(receipt)

    replay_bytes: Optional[bytes] = None
    if arguments.replay:
        # Second in-process build: the view must be a deterministic function
        # of the fixtures before it is compared with anything on disk.
        replay_html = render(
            a, b, a_name, b_name, analyze_pair(a, b), excluded, pair_note
        ).encode("utf-8")
        if replay_html != html_bytes:
            print(
                "replay: the second build differs from the first — no artifact written",
                file=sys.stderr,
            )
            return 1
        tool_source = tool_source_digests()
        expected_replay = {
            "generator": REPLAY_GENERATOR,
            "fixtures_root": "; ".join(roots),
            "compared": [a_name, b_name],
            "inputs": inputs,
            "tool_source": {"files": tool_source},
            "html_sha256": _sha(html_bytes),
            "rebuilt_html_sha256": _sha(replay_html),
            "receipt_sha256": _sha(receipt_bytes),
            "identical": True,
        }
        replay_bytes = _json_bytes(expected_replay)

    out = Path(arguments.out)
    stem = "{}-vs-{}".format(Path(a_name).stem, Path(b_name).stem)
    html_path = out / "view-{}.html".format(stem)
    receipt_path = out / "view-receipts-{}.json".format(stem)
    replay_path = out / "replay-{}.json".format(stem)

    if arguments.replay:
        existing = {
            name: path.read_bytes() if path.exists() else None
            for name, path in (
                ("view", html_path),
                ("receipt", receipt_path),
                ("replay", replay_path),
            )
        }
        if arguments.force:
            fresh = {
                "view": html_bytes,
                "receipt": receipt_bytes,
                "replay": replay_bytes,
            }
            replaced = [
                "{} (sha256 {} -> {})".format(
                    name,
                    "absent" if data is None else _sha(data),
                    _sha(fresh[name]),
                )
                for name, data in sorted(existing.items())
                if data is not None
            ]
            if replaced:
                print(
                    "replay: --force replaces existing evidence — {}; the "
                    "replaced bytes stay recoverable from version control".format(
                        "; ".join(replaced)
                    )
                )
        else:
            problems = replay_gate_disagreements(
                existing=existing,
                fresh_html=html_bytes,
                fresh_receipt=receipt,
                expected_replay=expected_replay,
                inputs=inputs,
                tool_source=tool_source,
                compared=[a_name, b_name],
            )
            if problems:
                for problem in problems:
                    print(problem, file=sys.stderr)
                print(
                    "replay: refusing to write — the existing evidence is preserved",
                    file=sys.stderr,
                )
                return 1
            if existing["view"] is not None:
                print("replay: existing evidence validated against a fresh build")

    # The write happens only after every gate above has passed: on any
    # disagreement the function has already returned and nothing on disk
    # was touched.
    out.mkdir(parents=True, exist_ok=True)
    html_path.write_bytes(html_bytes)
    receipt_path.write_bytes(receipt_bytes)
    print(
        "built {} ({} bytes) and {}".format(html_path, len(html_bytes), receipt_path)
    )
    if replay_bytes is not None:
        replay_path.write_bytes(replay_bytes)
        print("replay: byte-identical rebuild -> {}".format(replay_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
