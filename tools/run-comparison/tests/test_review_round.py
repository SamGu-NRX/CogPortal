"""Regression tests for the #113 review round's builder and verifier safeguards.

Four review threads asked for guarantees the old code did not give:

- a bare build over a directory holding generated evidence overwrote or
  mixed it with no probe. The gate must refuse, name --replay/--force,
  and leave every artifact untouched; --replay stays the validate-or-
  extend path, and a changed compared pair moves to its own stem without
  touching the old triple;
- with two --fixtures roots holding same-named reports, which copy the
  receipt attests depended on argument order. The inputs list must be
  ordered and duplicate-preserving, verified against the fixture bytes
  in that order — so changing the earlier copy's bytes (parsed
  disposition unchanged) must fail verification, and the order must not
  follow the argument order;
- the verifier read refusal reasons, provenance cells, the comparability
  banner and the causal-phrase rule only as digests. A digest-consistent
  rewrite of any of them must fail on the wording itself — the restamp
  helper below re-stamps every digest precisely so these tests reach
  the wording checks underneath (digest-only tampering is caught by the
  digest checks and has its own tests in test_replay_gate.py);
- the offline scan flagged report-sourced diagnostics text that merely
  names a URL, while a raw-text scan could miss an injected <script>.
  A URL in diagnostics must verify green and land in the rendered view;
  a digest-consistent <script> element must fail the structural scan.
"""

import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

WORKBENCH = Path(__file__).resolve().parents[1]
REPO_ROOT = WORKBENCH.parents[1]
FIXTURES = WORKBENCH / "fixtures"
PAIR_STEM = "01-run-a-vs-02-run-b"
VIEW = "view-{}.html".format(PAIR_STEM)
RECEIPT = "view-receipts-{}.json".format(PAIR_STEM)
REPLAY = "replay-{}.json".format(PAIR_STEM)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _run_build(out, *fixture_roots, extra=()):
    command = [sys.executable, str(WORKBENCH / "build.py")]
    for root in fixture_roots:
        command += ["--fixtures", str(root)]
    command += ["--out", str(out), *extra]
    return subprocess.run(command, capture_output=True, text=True, cwd=str(REPO_ROOT))


def _run_verify(out, *fixture_roots):
    command = [sys.executable, str(WORKBENCH / "verify.py")]
    for root in fixture_roots:
        command += ["--fixtures", str(root)]
    command += ["--out", str(out)]
    return subprocess.run(command, capture_output=True, text=True, cwd=str(REPO_ROOT))


def _copy_fixtures(tmp_path):
    target = tmp_path / "fixtures"
    shutil.copytree(FIXTURES, target)
    return target


def _build_evidence(tmp_path, fixtures=None, out=None):
    fixtures = fixtures if fixtures is not None else _copy_fixtures(tmp_path)
    out = out if out is not None else tmp_path / "evidence"
    built = _run_build(out, fixtures, extra=("--replay",))
    assert built.returncode == 0, built.stdout + built.stderr
    checked = _run_verify(out, fixtures)
    assert checked.returncode == 0, checked.stdout + checked.stderr
    return out, fixtures


def _restamp(out, mutate_html=None, mutate_receipt=None, stem=PAIR_STEM):
    """Rewrite the view and/or receipt, then re-stamp every digest so the
    tampered set is digest-consistent — reaching the verifier's wording
    checks, which would otherwise be answered by the digest checks."""

    html_path = out / "view-{}.html".format(stem)
    receipt_path = out / "view-receipts-{}.json".format(stem)
    replay_path = out / "replay-{}.json".format(stem)

    html = html_path.read_text(encoding="utf-8")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    replay = json.loads(replay_path.read_text(encoding="utf-8"))

    if mutate_html is not None:
        html = mutate_html(html)
    if mutate_receipt is not None:
        mutate_receipt(receipt)

    html_bytes = html.encode("utf-8")
    receipt["html_sha256"] = _sha(html_bytes)
    receipt_bytes = (
        json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")

    replay["html_sha256"] = _sha(html_bytes)
    replay["rebuilt_html_sha256"] = _sha(html_bytes)
    replay["receipt_sha256"] = _sha(receipt_bytes)

    html_path.write_bytes(html_bytes)
    receipt_path.write_bytes(receipt_bytes)
    replay_path.write_bytes(
        (json.dumps(replay, indent=2, sort_keys=True) + "\n").encode("utf-8")
    )


def test_bare_build_refuses_a_directory_holding_generated_evidence(tmp_path):
    out, fixtures = _build_evidence(tmp_path)
    before = {name: (out / name).read_bytes() for name in (VIEW, RECEIPT, REPLAY)}

    bare = _run_build(out, fixtures)

    assert bare.returncode != 0, bare.stdout + bare.stderr
    assert "already holds generated artifacts" in bare.stderr
    assert "--replay --force" in bare.stderr
    after = {name: (out / name).read_bytes() for name in (VIEW, RECEIPT, REPLAY)}
    assert after == before


def test_bare_build_writes_a_fresh_directory(tmp_path):
    # A bare build writes the view and receipt but not the replay
    # receipt: only a --replay run attests a byte-identical rebuild, so
    # bare evidence is incomplete by contract until a replay pass runs.
    fixtures = _copy_fixtures(tmp_path)
    out = tmp_path / "fresh"

    bare = _run_build(out, fixtures)

    assert bare.returncode == 0, bare.stdout + bare.stderr
    assert (out / VIEW).exists()
    assert (out / RECEIPT).exists()
    assert not (out / REPLAY).exists()
    incomplete = _run_verify(out, fixtures)
    assert incomplete.returncode == 1
    assert "evidence without its replay record is incomplete" in incomplete.stderr

    # The partial-evidence guard refuses plain --replay over a triple
    # missing its replay receipt, so completing bare evidence is a
    # deliberate --replay --force regeneration.
    replayed = _run_build(out, fixtures, extra=("--replay", "--force"))
    assert replayed.returncode == 0, replayed.stdout + replayed.stderr
    assert _run_verify(out, fixtures).returncode == 0


def test_same_named_reports_from_two_roots_bind_in_path_order(tmp_path):
    a_root = tmp_path / "a-root"
    b_root = tmp_path / "b-root"
    a_root.mkdir()
    b_root.mkdir()
    original = (FIXTURES / "01-run-a.json").read_bytes()
    a_bytes = original + b"\n"
    b_bytes = original + b"\n\n"
    (a_root / "01-run-a.json").write_bytes(a_bytes)
    (b_root / "01-run-a.json").write_bytes(b_bytes)

    first = tmp_path / "first"
    built = _run_build(first, a_root, b_root, extra=("--replay",))
    assert built.returncode == 0, built.stdout + built.stderr
    receipt = json.loads(
        (first / "view-receipts-01-run-a-vs-01-run-a.json").read_text(encoding="utf-8")
    )

    # Both same-named copies are attested, in path order — the argument
    # order must not decide which copy the receipt stands behind.
    entries = [
        entry for entry in receipt["inputs"] if entry["file"] == "01-run-a.json"
    ]
    assert [(entry["file"], entry["sha256"]) for entry in entries] == [
        ("01-run-a.json", _sha(a_bytes)),
        ("01-run-a.json", _sha(b_bytes)),
    ]

    flipped = tmp_path / "flipped"
    flipped_built = _run_build(flipped, b_root, a_root, extra=("--replay",))
    assert flipped_built.returncode == 0, flipped_built.stdout + flipped_built.stderr
    flipped_receipt = json.loads(
        (flipped / "view-receipts-01-run-a-vs-01-run-a.json").read_text(
            encoding="utf-8"
        )
    )
    assert flipped_receipt["inputs"] == receipt["inputs"]

    # Changing the earlier copy's bytes — same parsed content, different
    # file — must fail verification against the ordered inputs list.
    (a_root / "01-run-a.json").write_bytes(a_bytes + b"\n")
    checked = _run_verify(first, a_root, b_root)
    assert checked.returncode == 1, checked.stdout + checked.stderr
    assert "receipt inputs do not match the fixture bytes in order" in checked.stderr


def _same_named_roots(tmp_path):
    """Two roots that each hold an accepted run.json and a refused bad.json.

    The two copies of each name differ in content, and the two bad.json
    files are refused for different reasons.
    """

    left = tmp_path / "left"
    right = tmp_path / "right"
    left.mkdir()
    right.mkdir()
    (left / "run.json").write_bytes((FIXTURES / "01-run-a.json").read_bytes())
    (right / "run.json").write_bytes((FIXTURES / "02-run-b.json").read_bytes())
    (left / "bad.json").write_bytes(
        (FIXTURES / "07-refused-future-contract.json").read_bytes()
    )
    (right / "bad.json").write_bytes(
        (FIXTURES / "08-refused-unknown-command.json").read_bytes()
    )
    return left, right


def test_all_pairs_keeps_same_named_inputs_apart(tmp_path):
    # The record keyed inputs by file name, so left/run.json and
    # right/run.json collapsed into one digest and the pair read
    # ["run.json", "run.json"]. Each input needs its own identity, and
    # the record must not depend on argument order.
    from all_pairs_checks import collect

    left, right = _same_named_roots(tmp_path)

    record = collect([left, right])

    assert sorted(record["inputs"]) == [
        "left/bad.json",
        "left/run.json",
        "right/bad.json",
        "right/run.json",
    ]
    assert record["inputs"]["left/run.json"] == _sha((left / "run.json").read_bytes())
    assert record["inputs"]["right/run.json"] == _sha((right / "run.json").read_bytes())
    assert record["accepted_files"] == ["left/run.json", "right/run.json"]
    assert [entry["file"] for entry in record["refused_files"]] == [
        "left/bad.json",
        "right/bad.json",
    ]
    assert [pair["files"] for pair in record["pairs"]] == [
        ["left/run.json", "right/run.json"]
    ]
    assert collect([right, left]) == record


def test_verify_binds_each_same_named_refusal_to_its_own_reasons(tmp_path):
    # The verifier mapped refusal reasons by file name, so two refused
    # bad.json files from different roots collapsed into one entry and a
    # correct receipt failed verification against the other file's
    # reasons.
    left, right = _same_named_roots(tmp_path)
    out = tmp_path / "evidence"

    built = _run_build(out, left, right, extra=("--replay",))
    assert built.returncode == 0, built.stdout + built.stderr
    receipt = json.loads(
        (out / "view-receipts-run-vs-run.json").read_text(encoding="utf-8")
    )
    reasons = [entry["reasons"][0].split(":")[0] for entry in receipt["excluded"]]
    assert reasons == ["unsupported_contract", "unknown_command"]

    checked = _run_verify(out, left, right)

    assert checked.returncode == 0, checked.stdout + checked.stderr

    def swap(receipt):
        receipt["excluded"].reverse()

    _restamp(out, mutate_receipt=swap, stem="run-vs-run")
    swapped = _run_verify(out, left, right)
    assert swapped.returncode == 1, swapped.stdout + swapped.stderr
    assert "receipt refusal reasons" in swapped.stderr


def test_replay_refuses_a_receipt_attesting_a_different_pair(tmp_path):
    out, fixtures = _build_evidence(tmp_path)
    replay = json.loads((out / REPLAY).read_text(encoding="utf-8"))
    replay["compared"] = ["09-refused-malformed.json", "02-run-b.json"]
    tampered = (json.dumps(replay, indent=2, sort_keys=True) + "\n").encode("utf-8")
    (out / REPLAY).write_bytes(tampered)
    before = {name: (out / name).read_bytes() for name in (VIEW, RECEIPT, REPLAY)}
    assert before[REPLAY] == tampered

    run = _run_build(out, fixtures, extra=("--replay",))

    assert run.returncode != 0, run.stdout + run.stderr
    assert "the compared pair changed" in run.stderr
    assert "09-refused-malformed.json" in run.stderr
    assert "01-run-a.json" in run.stderr
    assert "refusing to write" in run.stderr
    after = {name: (out / name).read_bytes() for name in (VIEW, RECEIPT, REPLAY)}
    assert after == before  # the tampered bytes are preserved, not replaced


def test_replay_refuses_a_moved_pair_without_force(tmp_path):
    out, _ = _build_evidence(tmp_path)
    before = {name: (out / name).read_bytes() for name in (VIEW, RECEIPT, REPLAY)}

    later = tmp_path / "later-fixtures"
    later.mkdir()
    for name in ("02-run-b.json", "03-run-dirty.json"):
        shutil.copy2(FIXTURES / name, later / name)

    second = _run_build(out, later, extra=("--replay",))

    assert second.returncode == 1, second.stdout + second.stderr
    assert "the compared pair changed" in second.stderr
    assert "02-run-b.json vs 03-run-dirty.json" in second.stderr
    assert "--replay --force" in second.stderr
    # Nothing was written: the old evidence stands, no new stem exists.
    after = {name: (out / name).read_bytes() for name in (VIEW, RECEIPT, REPLAY)}
    assert after == before
    assert not list(out.glob("view-02-run-b-vs-03-run-dirty*"))


def test_replay_force_moves_the_pair_and_keeps_the_old_evidence(tmp_path):
    out, _ = _build_evidence(tmp_path)
    before = {name: (out / name).read_bytes() for name in (VIEW, RECEIPT, REPLAY)}

    later = tmp_path / "later-fixtures"
    later.mkdir()
    for name in ("02-run-b.json", "03-run-dirty.json"):
        shutil.copy2(FIXTURES / name, later / name)

    forced = _run_build(out, later, extra=("--replay", "--force"))

    assert forced.returncode == 0, forced.stdout + forced.stderr
    new_stem = "02-run-b-vs-03-run-dirty"
    assert (out / "view-{}.html".format(new_stem)).exists()
    assert (out / "view-receipts-{}.json".format(new_stem)).exists()
    assert (out / "replay-{}.json".format(new_stem)).exists()
    # The deliberately replaced evidence's bytes are not deleted by --force;
    # they stay exactly as they were, recoverable or removable by hand.
    after = {name: (out / name).read_bytes() for name in (VIEW, RECEIPT, REPLAY)}
    assert after == before
    assert _run_verify(out, later).returncode == 0


def test_verify_rejects_an_all_match_claim_over_a_changed_source(tmp_path):
    out, fixtures = _build_evidence(tmp_path)

    def mutate(receipt):
        receipt["findings"][0] = (
            "All recorded conditions match: source, dataset (benchmark, case "
            "set, weight bytes, scoring floors) and scorer identity."
        )

    _restamp(out, mutate_receipt=mutate)

    checked = _run_verify(out, fixtures)

    assert checked.returncode == 1, checked.stdout + checked.stderr
    assert "the leading finding reads" in checked.stderr
    assert "source differs between the runs" in checked.stderr


def test_verify_rejects_a_paraphrased_refusal_reason(tmp_path):
    out, fixtures = _build_evidence(tmp_path)

    def mutate(receipt):
        receipt["excluded"][0]["reasons"][0] += " (paraphrased)"

    _restamp(out, mutate_receipt=mutate)

    checked = _run_verify(out, fixtures)

    assert checked.returncode == 1, checked.stdout + checked.stderr
    assert "receipt refusal reasons for" in checked.stderr


def test_verify_rejects_a_causal_claim_even_when_digests_are_restamped(tmp_path):
    out, fixtures = _build_evidence(tmp_path)

    def mutate_html(html):
        return html.replace(
            "</main>",
            '<p class="muted">Every delta below is caused by the source '
            "change.</p></main>",
        )

    def mutate_receipt(receipt):
        receipt["findings"] = ["Every delta below is caused by the source change."]

    _restamp(out, mutate_html=mutate_html, mutate_receipt=mutate_receipt)

    checked = _run_verify(out, fixtures)

    assert checked.returncode == 1, checked.stdout + checked.stderr
    assert "causal claim" in checked.stderr


def test_verify_rejects_a_script_element_even_when_digests_are_restamped(tmp_path):
    out, fixtures = _build_evidence(tmp_path)

    def mutate(html):
        return html.replace(
            "</body>",
            '<script src="https://tamper.example.test/x.js"></script></body>',
        )

    _restamp(out, mutate_html=mutate)

    checked = _run_verify(out, fixtures)

    assert checked.returncode == 1, checked.stdout + checked.stderr
    assert "not an offline artifact" in checked.stderr


def test_verify_keeps_a_report_sourced_url_in_diagnostics_green(tmp_path):
    fixtures = _copy_fixtures(tmp_path)
    payload = json.loads(
        (fixtures / "01-run-a.json").read_text(encoding="utf-8")
    )
    payload["diagnostics"].append(
        "The producer failed to reach https://ci.example.test/artifacts "
        "for this run."
    )
    (fixtures / "01-run-a.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    out = tmp_path / "evidence"

    built = _run_build(out, fixtures, extra=("--replay",))
    assert built.returncode == 0, built.stdout + built.stderr
    checked = _run_verify(out, fixtures)

    assert checked.returncode == 0, checked.stdout + checked.stderr
    assert "https://ci.example.test/artifacts" in (out / VIEW).read_text(
        encoding="utf-8"
    )


def test_verify_rejects_a_tampered_provenance_cell(tmp_path):
    out, fixtures = _build_evidence(tmp_path)

    def mutate(html):
        return re.sub(
            r'(Commit</th><td>)[^<]*',
            lambda match: match.group(1) + "0123456789ab — pins the scored bytes",
            html,
            count=1,
        )

    _restamp(out, mutate_html=mutate)

    checked = _run_verify(out, fixtures)

    assert checked.returncode == 1, checked.stdout + checked.stderr
    assert "provenance 'Commit' cells" in checked.stderr


@pytest.mark.parametrize(
    "occurrence, table",
    [(0, "metric table"), (1, "floor table"), (2, "provenance table")],
)
def test_verify_rejects_swapped_run_column_labels(tmp_path, occurrence, table):
    # The verifier matched these tables by their first and last header
    # cells only, so a view whose run columns name the wrong reports
    # verified green. Swap the labels in one table at a time.
    out, fixtures = _build_evidence(tmp_path)
    original = (
        'Run A (01-run-a.json)</th><th scope="col">Run B (02-run-b.json)'
    )
    swapped = 'Run A (02-run-b.json)</th><th scope="col">Run B (01-run-a.json)'

    def mutate(html):
        parts = html.split(original)
        assert len(parts) == 4, "expected the metric, floor and provenance headers"
        return "".join(
            part + ((swapped if index == occurrence else original) if index < 3 else "")
            for index, part in enumerate(parts)
        )

    _restamp(out, mutate_html=mutate)

    checked = _run_verify(out, fixtures)

    assert checked.returncode == 1, checked.stdout + checked.stderr
    assert "the {} header".format(table) in checked.stderr


def _rewrite_metric(fixtures, name, key, **fields):
    payload = json.loads((fixtures / name).read_text(encoding="utf-8"))
    for entry in payload["metrics"]:
        if entry["key"] == key:
            entry.update(fields)
    (fixtures / name).write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def test_a_shared_metric_keeps_each_runs_unit(tmp_path):
    # The shared row carried run A's unit only, so 1.0 s against 1000.0 ms
    # rendered both values under "s". Each side keeps its own unit and the
    # row names the identity difference.
    fixtures = _copy_fixtures(tmp_path)
    _rewrite_metric(fixtures, "01-run-a.json", "ranking_failure_rate", unit="s", value=1.0)
    _rewrite_metric(fixtures, "02-run-b.json", "ranking_failure_rate", unit="ms", value=1000.0)

    out, _ = _build_evidence(tmp_path, fixtures=fixtures)

    receipt = json.loads((out / RECEIPT).read_text(encoding="utf-8"))
    row = {row["key"]: row for row in receipt["metrics"]["shared"]}["ranking_failure_rate"]
    assert (row["unit_a"], row["unit_b"]) == ("s", "ms")
    assert row["identity_differences"] == ["unit: s vs ms"]
    html = (out / VIEW).read_text(encoding="utf-8")
    assert "<td>1.000 s</td><td>1000.000 ms</td>" in html
    assert "identity differs between the runs: unit: s vs ms" in html

    _restamp(out, mutate_html=lambda text: text.replace("1000.000 ms", "1000.000 s"))
    checked = _run_verify(out, fixtures)
    assert checked.returncode == 1, checked.stdout + checked.stderr
    assert "metric row ranking_failure_rate run B cell" in checked.stderr


def test_floorless_pair_states_its_emptiness(tmp_path):
    fixtures = _copy_fixtures(tmp_path)
    for name in ("01-run-a.json", "02-run-b.json"):
        payload = json.loads((fixtures / name).read_text(encoding="utf-8"))
        payload["metrics"] = [
            metric for metric in payload["metrics"] if metric.get("role") != "floor"
        ]
        (fixtures / name).write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

    out, fixtures = _build_evidence(tmp_path, fixtures=fixtures)

    assert "No floor metrics recorded." in (out / VIEW).read_text(encoding="utf-8")
