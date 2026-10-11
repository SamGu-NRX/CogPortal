#!/usr/bin/env python3
"""Tests for tools/benchmark-data-attribution.

Strategy: unit-test the committed-metadata parsers against a synthetic clone
built in tmp_path (every file the generator reads, in the exact shape the
parsers expect), validate the generated inventory against the committed
schema, reject schema mutations, exercise the offline reader's guards, and
replay main() twice over two identical clones to prove byte-identical output
for the same baseRevision. No network is touched.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

TOOL_DIR = Path(__file__).resolve().parent


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, TOOL_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


inventory = _load("inventory")
validator = _load("validate")
reader = _load("reader")

SCHEMA = json.loads((TOOL_DIR / "schema" / "resources.schema.json").read_text(encoding="utf-8"))

WEEK1_GITLINK = "1" * 40
WEEK2_GITLINK = "2" * 40
WEEK3_GITLINK = "3" * 40

GITMODULES = """
[submodule "benchmarks/week1"]
\tpath = benchmarks/week1
\turl = https://github.com/SamGu-NRX/cogworks-week1-audio-benchmark.git
[submodule "benchmarks/week2"]
\tpath = benchmarks/week2
\turl = https://github.com/iReynaldo/ComputerVisionBenchmark.git
[submodule "benchmarks/week3"]
\tpath = benchmarks/week3
\turl = https://github.com/SamGu-NRX/cogworks-week3-language-benchmark.git
"""

ENVIRONMENT_PY = '''"""Runner image package tracks (synthetic fixture)."""
from typing import NamedTuple


class Package(NamedTuple):
    spec: str
    import_name: str


WEEK1_TRACK = (
    Package("numpy==1.26.4", "numpy"),
)

WEEK2_TRACK = (
    Package("torch==2.1.0", "torch"),
    Package(
        "facenet_models @ git+https://github.com/CogWorksBWSI/facenet_models.git@96b9599b03f26910b66f61ce725a8660e0ba654c",
        "facenet_models",
    ),
)

WEEK3_TRACK = (
    Package("scikit-learn==1.3.2", "sklearn"),
)
'''

WEEK3_DATASETS_PY = '''"""Week 3 dataset artifacts (synthetic fixture)."""
_RELEASE = "https://example.org/releases/"
ARTIFACTS: Dict[str, Dict[str, Any]] = {
    "captions": {
        "size": 9144353,
        "sha256": "@CAPTIONS_SHA@",
        "urls": [_RELEASE + "captions_train2014.json"],
    },
    "descriptors": {
        "size": 1234,
        "sha256": "@DESCRIPTORS_SHA@",
        "urls": ["https://example.org/resnet18_features.pkl"],
    },
    "glove": {
        "size": 5678,
        "sha256": "@GLOVE_SHA@",
        "urls": ["https://example.org/glove.6B.200d.txt.w2v"],
    },
}
'''.replace("@CAPTIONS_SHA@", "a" * 64).replace("@DESCRIPTORS_SHA@", "b" * 64).replace("@GLOVE_SHA@", "c" * 64)

MIT = "MIT License\n\nCopyright (c) 2026 {holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n"
WEEK2_COPYRIGHT = "Copyright (c) 2026 Reynaldo Jose Morillo Nolasco"

DATA_AND_SCORING_MD = """# Data and scoring

CelebA files are not redistributed by this repository.
See the CelebA agreement at http://mmlab.ie.cuhk.edu.hk/projects/CelebA.html.
See the Hugging Face dataset terms at https://huggingface.co/datasets/flwrlabs/celeba.
"""

COGWEB_README = """Mirror of https://rsokl.github.io/CogWeb/, captured 2026-09-01.

None of it is ours; it is an unedited mirror kept for design reference.
"""

CAPSTONES_README = """Edited subset of course material captured 2026-08-16.

None of it is ours; annotations are ours, the underlying text is not.
"""

FIXTURE_README = """Saved environments fixture.

CogPortal source commit: {cogportal}
Week 2 benchmark commit: {week2}
""".format(cogportal="d" * 40, week2="e" * 40)


def _write(root: Path, rel: str, content: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _json(values) -> str:
    return json.dumps(values, indent=2) + "\n"


def make_clone(root: Path) -> Path:
    """A minimal-but-complete clone: every file the generator reads."""
    _write(root, ".gitmodules", GITMODULES)
    _write(root, "LICENSE", MIT.format(holder="Sam Gu"))
    _write(root, "python/cogbench/LICENSE", MIT.format(holder="Sam Gu"))
    _write(root, "python/cogbench/src/cogbench/environment.py", ENVIRONMENT_PY)
    _write(root, "docs/cogweb/manifest.json", _json({
        "source": "https://rsokl.github.io/CogWeb/",
        "pages": ["a", "b"], "images": ["i"], "failed": [],
    }))
    _write(root, "docs/cogweb/README.md", COGWEB_README)
    _write(root, "docs/capstones/README.md", CAPSTONES_README)
    _write(root, "apps/runner-modal/tests/fixtures/saved_environments/README.md", FIXTURE_README)
    _write(root, "apps/runner-modal/tests/fixtures/saved_environments/LICENSE-week2-benchmark",
           MIT.format(holder="Reynaldo Jose Morillo Nolasco"))
    _write(root, "benchmarks/vision-recognition/src/cogworks_vision_benchmark/descriptor.json",
           _json({"pluginVersion": "1.0.0", "datasetVersion": "synthetic-v1"}))
    _write(root, "benchmarks/vision-recognition/DEPRECATED.md",
           "# Deprecated\n\nDo not install this package; it is retained for history only.\n")
    _write(root, "benchmarks/week2/LICENSE",
           "MIT License\n\n{}\n\nPermission is hereby granted.\n".format(WEEK2_COPYRIGHT))
    _write(root, "benchmarks/week2/docs/data-and-scoring.md", DATA_AND_SCORING_MD)
    _write(root, "benchmarks/week3/LICENSE", MIT.format(holder="Sam Gu"))
    _write(root, "docs/decisions/week1-corpus-determinism.md",
           "# Week 1 corpus determinism\n\nThe corpus is rendered from committed seeds.\n")
    _write(root, "benchmarks/week1/audio_identification_benchmark/datasets.py", '"""synthetic"""\n')
    _write(root, "benchmarks/week1/audio_identification_benchmark/manifests/public-test.json",
           _json({"manifest_id": "w1-test", "corpus_version": "synth-v1", "master_seed": 2026,
                  "songs": ["s1", "s2"], "out_of_set_songs": []}))
    _write(root, "benchmarks/week1/audio_identification_benchmark/manifests/public-evaluation.json",
           _json({"manifest_id": "w1-eval", "corpus_version": "synth-v1", "master_seed": 2026,
                  "songs": ["s1"], "out_of_set_songs": ["x"]}))
    _write(root, "benchmarks/week2/facial_recognition_benchmark/datasets.py", '"""synthetic"""\n')
    _write(root, "benchmarks/week2/facial_recognition_benchmark/model-lock.json",
           _json({"checkpoint": {"url": "https://example.org/facenet.pt",
                                 "sha256": "f" * 64, "size": 91095539}}))
    for tier, samples in (("public-test", 3), ("public-evaluation", 5)):
        _write(root, "benchmarks/week2/facial_recognition_benchmark/manifests/{}.json".format(tier),
               _json({"manifest_id": "w2-" + tier, "dataset": "flwrlabs/celeba",
                      "revision": "0" * 40, "split": tier, "samples": list(range(samples))}))
    _write(root, "benchmarks/week3/language_search_benchmark/datasets.py", WEEK3_DATASETS_PY)
    for tier in ("public-test", "public-evaluation", "showcase"):
        _write(root, "benchmarks/week3/language_search_benchmark/manifests/{}.json".format(tier),
               _json({"manifest_id": "w3-" + tier, "artifacts": {}}))

    env = dict(os.environ,
               GIT_AUTHOR_NAME="Test", GIT_AUTHOR_EMAIL="test@example.com",
               GIT_COMMITTER_NAME="Test", GIT_COMMITTER_EMAIL="test@example.com",
               GIT_AUTHOR_DATE="2026-01-01T00:00:00Z", GIT_COMMITTER_DATE="2026-01-01T00:00:00Z")

    def git(*args: str) -> str:
        return subprocess.run(["git", *args], cwd=str(root), check=True,
                              capture_output=True, text=True, env=env).stdout.strip()

    git("init", "-q")
    git("config", "user.name", "Test")
    git("config", "user.email", "test@example.com")
    git("add", "-A")
    # Submodule content is not tracked by the parent: drop it from the index,
    # then record the gitlinks, exactly as a real submodule checkout looks.
    git("rm", "-r", "-q", "--cached",
        "benchmarks/week1", "benchmarks/week2", "benchmarks/week3")
    for path, sha in (("benchmarks/week1", WEEK1_GITLINK),
                      ("benchmarks/week2", WEEK2_GITLINK),
                      ("benchmarks/week3", WEEK3_GITLINK)):
        git("update-index", "--add", "--cacheinfo", "160000,{},{}".format(sha, path))
    git("commit", "-q", "-m", "synthetic clone")
    return root


@pytest.fixture()
def clone(tmp_path):
    return make_clone(tmp_path / "clone")


# ---------------------------------------------------------------- parser units

def test_parse_gitmodules(clone):
    modules = inventory.parse_gitmodules(clone)
    assert modules["benchmarks/week1"] == "https://github.com/SamGu-NRX/cogworks-week1-audio-benchmark.git"


def test_gitlinks(clone):
    links = inventory.gitlinks(clone)
    assert links["benchmarks/week2"] == WEEK2_GITLINK


def test_environment_tracks_extracts_specs(clone):
    tracks = inventory.environment_tracks(clone)
    assert tracks["WEEK1_TRACK"] == ["numpy==1.26.4"]
    assert len(tracks["WEEK2_TRACK"]) == 2
    assert tracks["WEEK2_TRACK"][1].startswith("facenet_models @ git+https://")
    assert tracks["WEEK2_TRACK"][1].endswith("96b9599b03f26910b66f61ce725a8660e0ba654c")
    assert tracks["WEEK3_TRACK"] == ["scikit-learn==1.3.2"]


def test_week3_artifacts(clone):
    release, artifacts = inventory.week3_artifacts(clone)
    assert release == "https://example.org/releases/"
    assert set(artifacts) == {"captions", "descriptors", "glove"}
    assert artifacts["captions"]["sha256"] == "a" * 64
    # annotated-assign + concatenation form resolves to the full URL
    # (literal() normalizes lists to tuples; JSON output emits arrays)
    assert list(artifacts["captions"]["urls"]) == ["https://example.org/releases/captions_train2014.json"]
    assert list(artifacts["descriptors"]["urls"]) == ["https://example.org/resnet18_features.pkl"]


def test_counts_week1_manifests(clone):
    counts = inventory.counts_week1_manifests(clone)
    assert counts["public-test"]["songs"] == 2
    assert counts["public-evaluation"]["out_of_set_songs"] == 1
    assert counts["public-test"]["master_seed"] == 2026


def test_counts_week2_manifests(clone):
    counts = inventory.counts_week2_manifests(clone)
    assert counts["public-test"]["samples"] == 3
    assert counts["public-evaluation"]["samples"] == 5
    assert counts["public-test"]["revision"] == "0" * 40


def test_cogweb_facts(clone):
    facts = inventory.cogweb_facts(clone)
    assert facts["captured"] == "2026-09-01"
    assert facts["pages"] == 2 and facts["failed"] == 0


def test_fixture_facts_classifies_commits(clone):
    facts = inventory.fixture_facts(clone)
    assert facts["cogportalCommits"] == ["d" * 40]
    assert facts["week2BenchmarkCommits"] == ["e" * 40]


def test_quote_is_bounded_and_observational():
    text = "line one\n  spaced   line two with needle  \nline three"
    assert inventory.quote(text, "needle") == "spaced line two with needle"
    assert inventory.quote(text, "absent") == ""
    assert len(inventory.quote("x" * 500, "x")) <= 220


def test_file_notice_extracts_copyright(clone):
    notice = inventory.file_notice(clone, "LICENSE")
    assert notice["copyrightLine"].startswith("Copyright (c) 2026 Sam Gu")
    assert len(notice["sha256"]) == 64


# ------------------------------------------------------------- the inventory

def _wrap(resources):
    return {
        "schemaVersion": 1, "schema": inventory.SCHEMA_REF,
        "repo": inventory.REPO, "branch": inventory.BRANCH,
        "baseBranch": inventory.BASE_BRANCH, "baseRevision": WEEK1_GITLINK,
        "sources": [], "resources": resources,
    }


def test_inventory_validates_against_schema(clone):
    resources = inventory.build_resources(clone)
    assert len(resources) >= 12
    errors = validator.validate(_wrap(resources), SCHEMA)
    assert errors == [], "\n".join(errors)


def test_unknown_reuse_is_recorded_not_guessed(clone):
    resources = inventory.build_resources(clone)
    by_id = {r["id"]: r for r in resources}
    # The checkpoint and the week1 submodule have no committed notice.
    assert by_id["week2-facenet-checkpoint"]["reuse"]["evidenceState"] == "unknown"
    assert by_id["benchmarks-week1-submodule"]["reuse"]["evidenceState"] == "unknown"
    # Notices that ARE committed come out verified.
    assert by_id["benchmarks-week2-submodule"]["reuse"]["evidenceState"] == "verified"
    assert by_id["saved-environments-fixture"]["reuse"]["evidenceState"] == "verified"


def test_no_permission_claims_in_free_text(clone):
    resources = inventory.build_resources(clone)
    for resource in resources:
        for text in (resource["attribution"]["statement"], resource["notes"]):
            for phrase in reader.FORBIDDEN_CLAIMS:
                assert phrase not in text.lower(), (resource["id"], phrase)


def test_quotes_reproduce_committed_lines(clone):
    resources = inventory.build_resources(clone)
    by_id = {r["id"]: r for r in resources}
    fixture_quote = by_id["saved-environments-fixture"]["reuse"]["noticeReferences"][0]["quote"]
    assert "Reynaldo Jose Morillo Nolasco" in fixture_quote


def test_build_resources_is_deterministic(clone):
    first = json.dumps(inventory.build_resources(clone), sort_keys=True)
    second = json.dumps(inventory.build_resources(clone), sort_keys=True)
    assert first == second


# ----------------------------------------------------------------- validator

def _valid_document():
    return {
        "schemaVersion": 1, "schema": "schema/resources.schema.json",
        "repo": "SamGu-NRX/CogPortal", "branch": "b", "baseBranch": "bb",
        "baseRevision": "0" * 40,
        "sources": [{"path": "LICENSE", "sha256": "0" * 64}],
        "resources": [{
            "id": "x-resource", "kind": "dataset", "label": "X", "sourceGroup": "pinned-submodule",
            "version": "v1",
            "source": {"urls": ["https://example.org/x"], "pin": "p", "pinSource": "ps",
                       "evidenceState": "verified"},
            "entryPoints": [{"path": "a.py", "role": "r", "evidenceState": "verified"}],
            "reuse": {"evidenceState": "unknown", "noticeReferences": [
                {"path": "LICENSE", "relationship": "repository-license",
                 "evidenceState": "verified", "quote": "MIT License"},
            ]},
            "attribution": {"statement": "s", "evidenceState": "verified"},
            "declaredBy": ["a.py"], "notes": "",
        }],
    }


def test_validator_accepts_minimal_document():
    assert validator.validate(_valid_document(), SCHEMA) == []


@pytest.mark.parametrize("mutation,fragment", [
    (lambda doc: doc["resources"][0].__setitem__("kind", "not-a-kind"), "kind"),
    (lambda doc: doc["resources"][0].pop("notes"), "notes"),
    (lambda doc: doc["resources"][0].__setitem__("surprise", 1), "not allowed"),
    (lambda doc: doc.__setitem__("baseRevision", "short"), "baseRevision"),
    (lambda doc: doc["resources"][0]["reuse"].__setitem__("evidenceState", "permitted"), "permitted"),
    (lambda doc: doc["resources"][0]["reuse"]["noticeReferences"][0].__setitem__(
        "quote", "q" * 301), "longer than 300"),
    (lambda doc: doc.pop("sources"), "sources"),
])
def test_validator_rejects_mutations(mutation, fragment):
    document = _valid_document()
    mutation(document)
    errors = validator.validate(document, SCHEMA)
    assert errors, "expected the mutation to be rejected"
    assert any(fragment in e for e in errors), errors


def test_validator_cross_checked_with_jsonschema_if_available():
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.Draft202012Validator.check_schema(SCHEMA)
    errors = sorted(
        e.message for e in jsonschema.Draft202012Validator(SCHEMA).iter_errors(_valid_document())
    )
    assert errors == []


# -------------------------------------------------------------------- reader

def test_reader_guard_refuses_permission_claims():
    document = _valid_document()
    document["resources"][0]["notes"] = "Reuse is approved by the committee."
    with pytest.raises(SystemExit, match="approved by"):
        reader._guard(document)


def test_reader_guard_allows_mit_quotes():
    document = _valid_document()
    document["resources"][0]["reuse"]["noticeReferences"].append({
        "path": "LICENSE", "relationship": "repository-license",
        "evidenceState": "verified", "quote": "Permission is hereby granted, free of charge",
    })
    reader._guard(document)  # verbatim license quotes are observational


def test_reader_summary_and_unknowns(clone, capsys):
    out_dir = clone.parent / "out"
    assert inventory.main(["--out", str(out_dir), "--root", str(clone)]) == 0
    inventory_path = str(out_dir / "resources.json")
    assert reader.main(["reader.py", inventory_path, "summary"]) == 0
    assert "resources:" in capsys.readouterr().out
    assert reader.main(["reader.py", inventory_path, "unknowns"]) == 0
    assert "no committed reuse notice" in capsys.readouterr().out


# --------------------------------------------------------------------- main()

def test_main_reports_missing_inputs(clone, tmp_path, capsys):
    (clone / "LICENSE").unlink()
    code = inventory.main(["--out", str(tmp_path / "out"), "--root", str(clone)])
    assert code == 2
    assert "LICENSE" in capsys.readouterr().err


def test_main_output_is_deterministic_across_identical_clones(tmp_path):
    clone_a = make_clone(tmp_path / "a")
    clone_b = make_clone(tmp_path / "b")
    out_a, out_b = tmp_path / "outA", tmp_path / "outB"
    assert inventory.main(["--out", str(out_a), "--root", str(clone_a)]) == 0
    assert inventory.main(["--out", str(out_b), "--root", str(clone_b)]) == 0
    for name in ("resources.json", "summary.json", "summary.md"):
        assert (out_a / name).read_bytes() == (out_b / name).read_bytes(), name
    # And both validate against the committed schema.
    errors = validator.validate(json.loads((out_a / "resources.json").read_text()), SCHEMA)
    assert errors == []


def test_main_validates_before_writing(clone, tmp_path, monkeypatch):
    """A validator that reports violations must fail the run, not write output."""
    fake = types.ModuleType("validate")
    fake.validate = lambda *a, **k: ["injected violation"]
    monkeypatch.setitem(sys.modules, "validate", fake)
    out_dir = tmp_path / "out"
    code = inventory.main(["--out", str(out_dir), "--root", str(clone)])
    assert code == 1
    assert not (out_dir / "resources.json").exists()
