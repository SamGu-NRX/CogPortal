#!/usr/bin/env python3
"""Benchmark data attribution inventory for CogPortal.

Answers, from committed repository metadata only: what data, models, and
mirrored material do the CogWorks benchmarks use, where is each pinned, and
what reuse notices exist? Every claim is observational — what a committed
file SAYS, quoted and hashed — never an interpretation of permission. Where
no committed notice exists, the resource is recorded with evidenceState
"unknown"; nothing is guessed.

The generator is offline by default: it reads committed metadata (the parent
repo plus the pinned benchmark submodule checkouts) and refuses to run over a
checkout whose input files are not the committed bytes — uncommitted input
edits, a missing submodule checkout, or a submodule HEAD off its pin would
otherwise be recorded against the wrong commit. It writes
resources.json, summary.json, and summary.md. With --verify-urls it performs
bounded read-only reachability checks against the pinned URLs and records
them separately in url-checks.json — reachability is evidence about the
network, never about permission.

Output is validated against schema/resources.schema.json BEFORE anything is
written. Exit codes: 0 ok, 1 schema violation, 2 missing required inputs,
3 the checkout does not match the recorded commits.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, FrozenSet, List, Optional, Tuple

SCHEMA_VERSION = 1
SCHEMA_REF = "schema/resources.schema.json"
REPO = "SamGu-NRX/CogPortal"
BRANCH = "obv/products-l3-benchmark-data-attribution-20261010"
BASE_BRANCH = "fix/device-link-recovery-20261004"
URL_CHECK_CAP = 12
URL_TIMEOUT_SECONDS = 10

WEEK_PACKAGE_DIRS = {
    "week1": "benchmarks/week1/audio_identification_benchmark",
    "week2": "benchmarks/week2/facial_recognition_benchmark",
    "week3": "benchmarks/week3/language_search_benchmark",
}
ENVIRONMENT_REL = "python/cogbench/src/cogbench/environment.py"
COGWEB_DIR = "docs/cogweb"
CAPSTONES_README = "docs/capstones/README.md"
FIXTURE_DIR = "apps/runner-modal/tests/fixtures/saved_environments"
DEPRECATED_DIR = "benchmarks/vision-recognition"
DESCRIPTOR_REL = DEPRECATED_DIR + "/src/cogworks_vision_benchmark/descriptor.json"
DEPRECATED_REL = DEPRECATED_DIR + "/DEPRECATED.md"
WEEK1_DECISION_REL = "docs/decisions/week1-corpus-determinism.md"
WEEK2_SCORING_REL = "benchmarks/week2/docs/data-and-scoring.md"

REQUIRED_INPUTS = [
    ".gitmodules",
    "LICENSE",
    ENVIRONMENT_REL,
    "{}/manifest.json".format(COGWEB_DIR),
    "{}/README.md".format(COGWEB_DIR),
    CAPSTONES_README,
    "{}/README.md".format(FIXTURE_DIR),
    "{}/LICENSE-week2-benchmark".format(FIXTURE_DIR),
    DESCRIPTOR_REL,
    DEPRECATED_REL,
    WEEK1_DECISION_REL,
    WEEK2_SCORING_REL,
    WEEK_PACKAGE_DIRS["week1"] + "/manifests/public-test.json",
    WEEK_PACKAGE_DIRS["week1"] + "/manifests/public-evaluation.json",
    WEEK_PACKAGE_DIRS["week2"] + "/model-lock.json",
    WEEK_PACKAGE_DIRS["week2"] + "/manifests/public-test.json",
    WEEK_PACKAGE_DIRS["week2"] + "/manifests/public-evaluation.json",
    WEEK_PACKAGE_DIRS["week3"] + "/datasets.py",
]

# Files the generator reads only when they exist (their absence is recorded
# as an unknown, never a guess); hashed into "sources" when present.
OPTIONAL_CONSUMED_INPUTS = [
    "benchmarks/week1/LICENSE",
    "benchmarks/week2/LICENSE",
    "benchmarks/week3/LICENSE",
]
CONSUMED_INPUTS = REQUIRED_INPUTS + OPTIONAL_CONSUMED_INPUTS

SOURCE_GROUPS = [
    "pinned-submodule",
    "bundled-corpus",
    "repository-fixture",
    "deprecated-fixture",
]


# --------------------------------------------------------------------- io

def read_bytes(root: Path, rel: str) -> bytes:
    return (root / rel).read_bytes()


def read_text(root: Path, rel: str) -> str:
    return read_bytes(root, rel).decode("utf-8")


def read_text_if_exists(root: Path, rel: str) -> Optional[str]:
    path = root / rel
    return path.read_text(encoding="utf-8") if path.exists() else None


def read_json(root: Path, rel: str) -> Dict[str, Any]:
    return json.loads(read_text(root, rel))


def read_json_if_exists(root: Path, rel: str) -> Optional[Dict[str, Any]]:
    text = read_text_if_exists(root, rel)
    return json.loads(text) if text is not None else None


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def dump_json(path: Path, document: Any) -> None:
    path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def git(root: Path, *args: str, timeout: Optional[float] = None) -> str:
    result = subprocess.run(["git", *args], cwd=str(root), check=True,
                            capture_output=True, text=True, timeout=timeout)
    return result.stdout.strip()


def exists(root: Path, rel: str) -> bool:
    return (root / rel).exists()


# ------------------------------------------------------------ base parsers

def parse_gitmodules(root: Path) -> Dict[str, str]:
    """Submodule path -> clone URL, from the committed .gitmodules."""
    modules: Dict[str, str] = {}
    current: Optional[str] = None
    for line in read_text(root, ".gitmodules").splitlines():
        section = re.match(r'\[submodule "([^"]+)"\]', line.strip())
        if section:
            current = section.group(1)
            modules.setdefault(current, "")
            continue
        match = re.match(r'(\w+)\s*=\s*(.+)$', line.strip())
        if match and current is not None:
            key, value = match.groups()
            if key == "path":
                modules[current] = value.strip()
                current = value.strip()
                modules.setdefault(current, modules.get(current, ""))
            elif key == "url" and current is not None:
                modules[current] = value.strip()
    return modules


def gitlinks(root: Path) -> Dict[str, str]:
    """Submodule path -> pinned commit, from the parent repo's index."""
    links: Dict[str, str] = {}
    for line in git(root, "ls-tree", "-r", "HEAD").splitlines():
        meta, _, path = line.partition("\t")
        mode, kind, sha = meta.split()
        if kind == "commit":
            links[path] = sha
    return links


def static_assigns(root: Path, rel: str) -> Dict[str, Any]:
    """Module-level constants we can evaluate without importing the file.

    Supports literals, tuples/lists of literals, and string concatenation —
    deliberately nothing else. Anything dynamic is skipped rather than
    approximated.
    """
    def literal(node: ast.AST, seen: FrozenSet[str] = frozenset()) -> Any:
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            # The value the name already had at this point in the file
            # (in-order module constants). Cycles and forward references are
            # refused, never approximated by re-reading a later assignment.
            if node.id in seen:
                raise ValueError("cyclic reference: " + node.id)
            if node.id in names:
                return names[node.id]
            raise ValueError("unresolved name: " + node.id)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left, right = literal(node.left, seen), literal(node.right, seen)
            if isinstance(left, str) and isinstance(right, str):
                return left + right
            raise ValueError("unsupported concatenation")
        if isinstance(node, (ast.Tuple, ast.List)):
            return tuple(literal(item) for item in node.elts)
        if isinstance(node, ast.Dict):
            return {literal(key): literal(value) for key, value in zip(node.keys, node.values)}
        raise ValueError("unsupported literal")

    names: Dict[str, Any] = {}
    names_ast: Dict[str, ast.AST] = {}
    tree = ast.parse(read_text(root, rel), filename=rel)
    for node in tree.body:
        targets: List[ast.AST] = []
        if isinstance(node, ast.Assign):
            targets = list(node.targets)
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            # ``NAME: SomeType = value`` module constants (week3 ARTIFACTS).
            targets = [node.target]
        for target in targets:
            if not isinstance(target, ast.Name):
                continue
            try:
                value = literal(node.value)
            except ValueError:
                continue
            names[target.id] = value
            names_ast[target.id] = node.value
    return names


def environment_tracks(root: Path) -> Dict[str, List[str]]:
    """The pinned pip package specs per week track, from environment.py."""
    rel = ENVIRONMENT_REL
    tracks: Dict[str, List[str]] = {t: [] for t in ("WEEK1_TRACK", "WEEK2_TRACK", "WEEK3_TRACK")}
    # Each track is a tuple of Package("spec", "import") calls; take the spec
    # argument of each call directly from the AST.
    tree = ast.parse(read_text(root, rel), filename=rel)
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if not isinstance(target, ast.Name) or target.id not in tracks:
                continue
            if not isinstance(node.value, ast.Tuple):
                continue
            for element in node.value.elts:
                if isinstance(element, ast.Call) and element.args:
                    first = element.args[0]
                    if isinstance(first, ast.Constant) and isinstance(first.value, str):
                        tracks[target.id].append(first.value)
    return tracks


def week3_artifacts(root: Path) -> Tuple[str, Dict[str, Dict[str, Any]]]:
    """``_RELEASE`` and the pinned ``ARTIFACTS`` table of the week3 benchmark."""
    rel = WEEK_PACKAGE_DIRS["week3"] + "/datasets.py"
    names = static_assigns(root, rel)
    if "_RELEASE" not in names or "ARTIFACTS" not in names:
        raise RuntimeError("week3 datasets.py no longer declares _RELEASE/ARTIFACTS")
    return str(names["_RELEASE"]), dict(names["ARTIFACTS"])


def counts_week1_manifests(root: Path) -> Dict[str, Dict[str, Any]]:
    """Per-tier counts from the week1 committed corpus manifests."""
    counts: Dict[str, Dict[str, Any]] = {}
    base = WEEK_PACKAGE_DIRS["week1"] + "/manifests"
    for tier in ("public-test", "public-evaluation"):
        manifest = read_json_if_exists(root, "{}/{}.json".format(base, tier))
        if manifest is None:
            continue
        counts[tier] = {
            "songs": len(manifest.get("songs", [])),
            "out_of_set_songs": len(manifest.get("out_of_set_songs", [])),
            "master_seed": manifest.get("master_seed"),
            "corpus_version": manifest.get("corpus_version"),
        }
    return counts


def counts_week2_manifests(root: Path) -> Dict[str, Dict[str, Any]]:
    """Per-tier counts from the week2 committed dataset manifests."""
    counts: Dict[str, Dict[str, Any]] = {}
    base = WEEK_PACKAGE_DIRS["week2"] + "/manifests"
    for tier in ("public-test", "public-evaluation"):
        manifest = read_json_if_exists(root, "{}/{}.json".format(base, tier))
        if manifest is None:
            continue
        counts[tier] = {
            "samples": len(manifest.get("samples", [])),
            "dataset": manifest.get("dataset"),
            "revision": manifest.get("revision"),
            "split": manifest.get("split"),
        }
    return counts


def cogweb_facts(root: Path) -> Dict[str, Any]:
    """What docs/cogweb/manifest.json and its README state about the mirror."""
    manifest = read_json(root, "{}/manifest.json".format(COGWEB_DIR))
    readme = read_text(root, "{}/README.md".format(COGWEB_DIR))
    captured = re.search(r"captured (\d{4}-\d{2}-\d{2})", readme, re.IGNORECASE)
    return {
        "source": manifest.get("source", "unknown"),
        "pages": len(manifest.get("pages", [])),
        "images": len(manifest.get("images", [])),
        "failed": len(manifest.get("failed", [])),
        "captured": captured.group(1) if captured else "unknown",
    }


def fixture_facts(root: Path) -> Dict[str, List[str]]:
    """Commit pins recorded in the saved-environments fixture README.

    The committed README records pins as backtick-quoted hashes after the
    source name ("CogPortal `8871f88...`"); the legacy "commit: <sha>" shape
    is still accepted. Matches are de-duplicated in file order; only lines
    that name CogPortal feed ``cogportalCommits`` and only lines that name
    the Week 2 benchmark feed ``week2BenchmarkCommits``.
    """
    commits: Dict[str, List[str]] = {"cogportal": [], "week2": []}
    readme = read_text(root, "{}/README.md".format(FIXTURE_DIR))
    for line in readme.splitlines():
        lowered = line.lower()
        shas = re.findall(r"`?([0-9a-f]{40})`?", line)
        if not shas:
            continue
        if "cogportal" in lowered:
            label = "cogportal"
        elif "week 2" in lowered or "benchmark" in lowered:
            label = "week2"
        else:
            label = None
        for sha in shas:
            if label and sha not in commits[label]:
                commits[label].append(sha)
    return {"cogportalCommits": commits["cogportal"], "week2BenchmarkCommits": commits["week2"]}
def quote(text: str, needle: str) -> str:
    """The line containing ``needle``, whitespace-collapsed and bounded.

    Quotes are verbatim file content: observational evidence only.
    """
    for line in text.splitlines():
        if needle in line:
            collapsed = " ".join(line.split())
            return collapsed[:220]
    return ""


def file_notice(root: Path, rel: str) -> Dict[str, str]:
    """Copyright line and hash of a committed notice file."""
    data = read_bytes(root, rel)
    return {"copyrightLine": quote(data.decode("utf-8", errors="replace"), "Copyright"),
            "sha256": sha256_bytes(data)}


def noticed(root: Path, path: str, relationship: str, evidence_state: str,
            needle: str = "Copyright") -> Dict[str, Any]:
    """A noticeReference pointing at committed content, quote included.

    A reference may only claim ``evidenceState`` when its quoted text
    actually occurs in the committed file; an unmatched needle downgrades
    the reference to ``unknown`` with an empty quote instead of recording
    verified evidence that cannot be checked.
    """
    text = read_text_if_exists(root, path)
    quote_text = quote(text, needle) if text is not None else ""
    if not quote_text:
        evidence_state = "unknown"
    return {
        "path": path,
        "relationship": relationship,
        "evidenceState": evidence_state,
        "quote": quote_text,
    }


def reuse_state_for(notices: List[Dict[str, Any]]) -> str:
    """A resource's reuse state derives from its noticeReferences: the best
    evidence actually recorded (verified over secondary over unknown), so a
    failed quote check cannot leave a stronger claim behind."""
    states = {n["evidenceState"] for n in notices}
    if "verified" in states:
        return "verified"
    if "secondary" in states:
        return "secondary"
    return "unknown"


# -------------------------------------------------------------- resources

def _resource(resource_id: str, kind: str, label: str, source_group: str, version: str,
              urls: List[str], pin: str, pin_source: str, source_state: str,
              entry_points: List[Dict[str, str]], reuse_state: str,
              notices: List[Dict[str, Any]], statement: str, statement_state: str,
              declared_by: List[str], notes: str) -> Dict[str, Any]:
    return {
        "id": resource_id,
        "kind": kind,
        "label": label,
        "sourceGroup": source_group,
        "version": version,
        "source": {
            "urls": urls,
            "pin": pin,
            "pinSource": pin_source,
            "evidenceState": source_state,
        },
        "entryPoints": entry_points,
        "reuse": {
            "evidenceState": reuse_state,
            "noticeReferences": notices,
        },
        "attribution": {
            "statement": statement,
            "evidenceState": statement_state,
        },
        "declaredBy": declared_by,
        "notes": notes,
    }


def build_resources(root: Path) -> List[Dict[str, Any]]:
    """Every benchmark data resource this repository commits metadata for.

    Deterministic: sorted sources, stable resource order, no timestamps.
    """
    modules = parse_gitmodules(root)
    links = gitlinks(root)
    tracks = environment_tracks(root)
    cogweb = cogweb_facts(root)
    fixtures = fixture_facts(root)
    week1_counts = counts_week1_manifests(root)
    week2_counts = counts_week2_manifests(root)
    resources: List[Dict[str, Any]] = []

    def entry(path: str, role: str) -> Dict[str, str]:
        return {"path": path, "role": role,
                "evidenceState": "verified" if exists(root, path) else "unknown"}

    # -- the three pinned benchmark submodules -----------------------------
    week1_license = read_text_if_exists(root, "benchmarks/week1/LICENSE")
    week1_notices = ([noticed(root, "benchmarks/week1/LICENSE", "upstream-license", "verified")]
                     if week1_license else [])
    resources.append(_resource(
        "benchmarks-week1-submodule", "code-submodule",
        "Week 1 audio identification benchmark (pinned submodule)",
        "pinned-submodule", links.get("benchmarks/week1", "unpinned"),
        [modules.get("benchmarks/week1", "unknown")], links.get("benchmarks/week1", "unpinned"),
        "benchmarks/week1 gitlink", "verified",
        [entry(WEEK_PACKAGE_DIRS["week1"] + "/datasets.py", "corpus generator"),
         entry(WEEK_PACKAGE_DIRS["week1"] + "/manifests/public-test.json", "committed corpus manifest"),
         entry(WEEK_PACKAGE_DIRS["week1"] + "/manifests/public-evaluation.json", "committed corpus manifest")],
        reuse_state_for(week1_notices),
        week1_notices,
        "Committed metadata pins this submodule at {} via the parent gitlink.".format(links.get("benchmarks/week1", "?")),
        "verified" if week1_license is not None else "unknown",
        [".gitmodules"],
        ("A LICENSE file is committed at the checked-out revision."
         if week1_license is not None else
         "No LICENSE file was found at the checked-out revision of this submodule; "
         "recorded as unknown, not guessed.")))

    week2_license = read_text_if_exists(root, "benchmarks/week2/LICENSE")
    week2_notices = []
    if week2_license is not None:
        week2_notices.append(noticed(root, "benchmarks/week2/LICENSE", "upstream-license", "verified"))
    if exists(root, WEEK2_SCORING_REL):
        week2_notices.append(noticed(root, WEEK2_SCORING_REL, "terms-pointer", "secondary",
                                     needle="CelebA"))
    resources.append(_resource(
        "benchmarks-week2-submodule", "code-submodule",
        "Week 2 facial recognition benchmark (pinned submodule)",
        "pinned-submodule", links.get("benchmarks/week2", "unpinned"),
        [modules.get("benchmarks/week2", "unknown")], links.get("benchmarks/week2", "unpinned"),
        "benchmarks/week2 gitlink", "verified",
        [entry(WEEK_PACKAGE_DIRS["week2"] + "/datasets.py", "dataset loader"),
         entry(WEEK_PACKAGE_DIRS["week2"] + "/model-lock.json", "model pin"),
         entry(WEEK_PACKAGE_DIRS["week2"] + "/manifests/public-test.json", "committed dataset manifest"),
         entry(WEEK_PACKAGE_DIRS["week2"] + "/manifests/public-evaluation.json", "committed dataset manifest")],
        reuse_state_for(week2_notices),
        week2_notices,
        "Committed metadata pins this submodule at {} via the parent gitlink; its committed LICENSE states a copyright line.".format(links.get("benchmarks/week2", "?")),
        "verified" if week2_license is not None else "unknown",
        [".gitmodules"],
        "Dataset terms are referenced by the committed data-and-scoring document, which points to the CelebA agreement and Hugging Face terms without reproducing them."))

    week3_license = read_text_if_exists(root, "benchmarks/week3/LICENSE")
    week3_notices = ([noticed(root, "benchmarks/week3/LICENSE", "upstream-license", "verified")]
                     if week3_license else [])
    resources.append(_resource(
        "benchmarks-week3-submodule", "code-submodule",
        "Week 3 language search benchmark (pinned submodule)",
        "pinned-submodule", links.get("benchmarks/week3", "unpinned"),
        [modules.get("benchmarks/week3", "unknown")], links.get("benchmarks/week3", "unpinned"),
        "benchmarks/week3 gitlink", "verified",
        [entry(WEEK_PACKAGE_DIRS["week3"] + "/datasets.py", "artifact table")],
        reuse_state_for(week3_notices),
        week3_notices,
        "Committed metadata pins this submodule at {} via the parent gitlink.".format(links.get("benchmarks/week3", "?")),
        "verified" if week3_license is not None else "unknown",
        [".gitmodules"],
        ("A LICENSE file is committed at the checked-out revision."
         if week3_license is not None else
         "No LICENSE file was found at the checked-out revision of this submodule; "
         "recorded as unknown, not guessed.")))

    # -- week2 model checkpoint --------------------------------------------
    lock = read_json_if_exists(root, WEEK_PACKAGE_DIRS["week2"] + "/model-lock.json")
    checkpoint = (lock or {}).get("checkpoint", {}) if isinstance(lock, dict) else {}
    resources.append(_resource(
        "week2-facenet-checkpoint", "model-checkpoint",
        "FaceNet model checkpoint pinned by week2",
        "pinned-submodule", checkpoint.get("sha256", "unpinned"),
        [checkpoint.get("url", "unknown")], checkpoint.get("sha256", "unpinned"),
        WEEK_PACKAGE_DIRS["week2"] + "/model-lock.json checkpoint.sha256",
        "verified" if checkpoint else "unknown",
        [entry(WEEK_PACKAGE_DIRS["week2"] + "/model-lock.json", "pin file")],
        "unknown", [],
        "The committed model-lock.json records a URL and a sha256 for this checkpoint.",
        "verified" if checkpoint else "unknown",
        [WEEK_PACKAGE_DIRS["week2"] + "/model-lock.json"],
        "No reuse notice for this checkpoint was found in the committed metadata; recorded as unknown, not guessed."))

    # -- week3 dataset artifacts -------------------------------------------
    if exists(root, WEEK_PACKAGE_DIRS["week3"] + "/datasets.py"):
        release, artifacts = week3_artifacts(root)
        artifact_ids = {"captions": "week3-coco-captions",
                        "descriptors": "week3-resnet-features",
                        "glove": "week3-glove-vectors"}
        labels = {"captions": "COCO captions_train2014.json",
                  "descriptors": "resnet18_features.pkl",
                  "glove": "GloVe 6B 200d word vectors"}
        for key, resource_id in artifact_ids.items():
            artifact = artifacts.get(key)
            if not artifact:
                continue
            resources.append(_resource(
                resource_id, "dataset", labels[key],
                "pinned-submodule", release,
                list(artifact.get("urls", ["unknown"])), artifact.get("sha256", "unpinned"),
                WEEK_PACKAGE_DIRS["week3"] + "/datasets.py ARTIFACTS.{}.sha256".format(key),
                "verified",
                [entry(WEEK_PACKAGE_DIRS["week3"] + "/datasets.py", "artifact table")],
                "unknown", [],
                "The committed datasets.py records this artifact's size, sha256, and URL for release {}.".format(release),
                "verified",
                [WEEK_PACKAGE_DIRS["week3"] + "/datasets.py"],
                "No reuse notice for this artifact was found in the committed metadata; recorded as unknown, not guessed."))

    # -- week1 bundled corpus ----------------------------------------------
    counts = week1_counts.get("public-evaluation", {})
    week1_decision_notice = noticed(root, WEEK1_DECISION_REL, "decision-record", "verified",
                                    needle="renders seeded synthetic music")
    resources.append(_resource(
        "week1-corpus", "bundled-corpus",
        "Week 1 audio identification corpus (generated from committed seeds)",
        "bundled-corpus", counts.get("corpus_version", "unversioned"),
        ["file://" + WEEK_PACKAGE_DIRS["week1"] + "/manifests/public-evaluation.json"],
        "master_seed={}".format(counts.get("master_seed", "unrecorded")),
        WEEK_PACKAGE_DIRS["week1"] + "/manifests manifest master_seed",
        "verified" if counts else "unknown",
        [entry(WEEK_PACKAGE_DIRS["week1"] + "/datasets.py", "corpus generator"),
         entry(WEEK_PACKAGE_DIRS["week1"] + "/manifests/public-test.json", "committed corpus manifest"),
         entry(WEEK_PACKAGE_DIRS["week1"] + "/manifests/public-evaluation.json", "committed corpus manifest")],
        reuse_state_for([week1_decision_notice]),
        [week1_decision_notice],
        "The committed decision record states the corpus is rendered from committed seeds; counts derive from the committed manifests.",
        week1_decision_notice["evidenceState"],
        [WEEK1_DECISION_REL],
        "public-test manifest: {} songs; public-evaluation manifest: {} songs, {} out-of-set.".format(
            week1_counts.get("public-test", {}).get("songs", "?"),
            counts.get("songs", "?"), counts.get("out_of_set_songs", "?"))))

    # -- week2 CelebA dataset ----------------------------------------------
    tier = week2_counts.get("public-evaluation", {})
    dataset = tier.get("dataset", "flwrlabs/celeba")
    revision = tier.get("revision", "unrecorded")
    celeba_terms_notice = noticed(root, WEEK2_SCORING_REL, "terms-pointer", "secondary",
                                  needle="CelebA")
    resources.append(_resource(
        "week2-celeba-dataset", "dataset",
        "CelebA dataset used by week2",
        "pinned-submodule", revision,
        ["https://huggingface.co/datasets/{}".format(dataset),
         "http://mmlab.ie.cuhk.edu.hk/projects/CelebA.html"],
        revision, WEEK_PACKAGE_DIRS["week2"] + "/manifests revision",
        "verified" if revision != "unrecorded" else "unknown",
        [entry(WEEK_PACKAGE_DIRS["week2"] + "/manifests/public-test.json", "committed dataset manifest"),
         entry(WEEK_PACKAGE_DIRS["week2"] + "/manifests/public-evaluation.json", "committed dataset manifest")],
        reuse_state_for([celeba_terms_notice]),
        [celeba_terms_notice],
        "Committed manifests pin dataset {} at revision {}; the committed data-and-scoring document points to the dataset agreement and Hugging Face terms without reproducing them.".format(dataset, revision),
        "verified" if revision != "unrecorded" else "unknown",
        [WEEK2_SCORING_REL],
        "The terms themselves are not reproduced in this repository; follow the committed pointers to read them."))

    # -- CogWeb mirror -------------------------------------------------------
    cogweb_notice = noticed(root, COGWEB_DIR + "/README.md", "readme-statement", "verified",
                            needle="None of it is ours")
    resources.append(_resource(
        "cogweb-mirror", "documentation-mirror",
        "CogWeb documentation mirror (docs/cogweb)",
        "repository-fixture", "captured-{}".format(cogweb["captured"]),
        [cogweb["source"]], "captured-{}".format(cogweb["captured"]),
        COGWEB_DIR + "/README.md capture date", "verified",
        [entry(COGWEB_DIR + "/manifest.json", "capture manifest"),
         entry(COGWEB_DIR + "/README.md", "capture record")],
        reuse_state_for([cogweb_notice]),
        [cogweb_notice],
        "The committed capture record states the mirror is unedited and kept for design reference; {} pages and {} images captured, {} failed.".format(cogweb["pages"], cogweb["images"], cogweb["failed"]),
        "verified",
        [COGWEB_DIR + "/manifest.json"],
        "The mirrored text is not claimed as original work; see the quoted capture record."))

    # -- curated capstones ----------------------------------------------------
    capstones_notice = noticed(root, CAPSTONES_README, "readme-statement", "verified",
                               needle="None of it is ours")
    resources.append(_resource(
        "capstones-mirror", "documentation-mirror",
        "Curated capstones capture (docs/capstones)",
        "repository-fixture", "unversioned",
        ["file://" + CAPSTONES_README], "unversioned", CAPSTONES_README, "verified",
        [entry(CAPSTONES_README, "capture record")],
        reuse_state_for([capstones_notice]),
        [capstones_notice],
        "The committed capture record states this is an edited subset of course material and that the underlying text is not ours.",
        "verified",
        [CAPSTONES_README],
        "Annotations in this directory are original; the underlying captured text is not."))

    # -- saved-environments fixture -----------------------------------------
    license_name = "LICENSE-week2-benchmark"
    fixture_license_notice = noticed(root, "{}/{}".format(FIXTURE_DIR, license_name),
                                     "upstream-license", "verified")
    fixture_notices = [fixture_license_notice,
                       noticed(root, FIXTURE_DIR + "/README.md", "readme-statement", "verified",
                               needle="Week 2 benchmark")]
    resources.append(_resource(
        "saved-environments-fixture", "repository-fixture",
        "Saved environments fixture (apps/runner-modal tests)",
        "repository-fixture", "unversioned",
        ["file://" + FIXTURE_DIR + "/README.md"],
        fixtures["week2BenchmarkCommits"][0] if fixtures["week2BenchmarkCommits"] else "unrecorded",
        FIXTURE_DIR + "/README.md recorded commit", "verified",
        [entry(FIXTURE_DIR + "/README.md", "fixture record"),
         entry(FIXTURE_DIR + "/" + license_name, "bundled upstream license")],
        reuse_state_for(fixture_notices),
        fixture_notices,
        "The fixture bundles the week2 benchmark environment with an upstream LICENSE file committed alongside it; the README records the source commits it was captured from.",
        "verified",
        [FIXTURE_DIR + "/README.md"],
        "Fixture content belongs to the recorded upstream commits; the bundled license file is the committed notice."))

    # -- deprecated vision-recognition fixture ------------------------------
    descriptor = read_json(root, DESCRIPTOR_REL)
    deprecated_notice = noticed(root, DEPRECATED_REL, "readme-statement", "verified",
                                needle="history only")
    resources.append(_resource(
        "vision-recognition-deprecated", "deprecated-fixture",
        "vision-recognition package (retained for history)",
        "deprecated-fixture", descriptor.get("pluginVersion", "unversioned"),
        ["file://" + DEPRECATED_REL], descriptor.get("pluginVersion", "unversioned"),
        DESCRIPTOR_REL + " pluginVersion", "verified",
        [entry(DESCRIPTOR_REL, "package descriptor"),
         entry(DEPRECATED_REL, "deprecation record")],
        reuse_state_for([deprecated_notice]),
        [deprecated_notice],
        "The committed deprecation record states the package is retained for history and should not be installed.",
        "verified",
        [DEPRECATED_REL],
        "datasetVersion in the descriptor is {}; the package is not part of the active benchmark set.".format(descriptor.get("datasetVersion", "?"))))

    return resources


# --------------------------------------------------------- url verification

def fetch_submodule_pins(root: Path, modules: Dict[str, str], links: Dict[str, str]) -> Dict[str, Any]:
    """Confirm each pinned submodule commit is reachable at its remote.

    ``git ls-remote <url> <sha>`` is read-only and passes the pinned commit
    explicitly, so a moved default branch cannot mask a broken pin.
    """
    results: Dict[str, Any] = {}
    for path in sorted(modules):
        url, sha = modules[path], links.get(path, "")
        if not sha:
            results[path] = {"url": url, "pin": "", "reachable": False, "detail": "no gitlink"}
            continue
        try:
            git(root, "ls-remote", url, sha, timeout=URL_TIMEOUT_SECONDS)
            results[path] = {"url": url, "pin": sha, "reachable": True, "detail": "pin reachable"}
        except subprocess.TimeoutExpired:
            results[path] = {"url": url, "pin": sha, "reachable": False,
                             "detail": "ls-remote timed out after {}s".format(URL_TIMEOUT_SECONDS)}
        except subprocess.CalledProcessError as error:
            results[path] = {"url": url, "pin": sha, "reachable": False,
                             "detail": "ls-remote failed: {}".format(error.returncode)}
    return results


def collect_urls(resources: List[Dict[str, Any]]) -> List[Tuple[str, str, str]]:
    """(resource, url, kind) triples in a stable order, capped at URL_CHECK_CAP."""
    pairs: List[Tuple[str, str, str]] = []
    for resource in resources:
        for url in resource["source"]["urls"]:
            if not url.startswith(("http://", "https://")):
                continue
            kind = "git-remote" if url.endswith(".git") else "http"
            pairs.append((resource["id"], url, kind))
    return pairs[:URL_CHECK_CAP]


def verify_urls(root: Path, resources: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Bounded read-only reachability checks. Evidence about the network,
    never about permission."""
    results: List[Dict[str, Any]] = []
    for resource_id, url, kind in collect_urls(resources):
        record: Dict[str, Any] = {"resource": resource_id, "url": url, "kind": kind}
        if kind == "git-remote":
            try:
                git(root, "ls-remote", url, timeout=URL_TIMEOUT_SECONDS)
                record.update(reachability="reachable", status="ls-remote ok")
            except subprocess.TimeoutExpired:
                record.update(reachability="unreachable",
                              status="ls-remote timed out after {}s".format(URL_TIMEOUT_SECONDS))
            except subprocess.CalledProcessError:
                record.update(reachability="unreachable", status="ls-remote failed")
        else:
            request = urllib.request.Request(url, method="HEAD",
                                             headers={"User-Agent": "cogportal-attribution-inventory"})
            try:
                with urllib.request.urlopen(request, timeout=URL_TIMEOUT_SECONDS) as response:
                    record.update(reachability="reachable", status=response.status)
            except urllib.error.HTTPError as error:
                record.update(reachability="unreachable", status=error.code)
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                record.update(reachability="unreachable", status="connection-error: {}".format(error))
        results.append(record)
    return {"sourceRevision": git(root, "rev-parse", "HEAD"), "results": results}


# ---------------------------------------------------------------- summary

def summarize(resources: List[Dict[str, Any]], url_checks: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    groups: Dict[str, Dict[str, int]] = {}

    def group(group_name: str) -> Dict[str, int]:
        return groups.setdefault(group_name, {
            "resources": 0,
            "verifiedReferences": 0,
            "secondaryReferences": 0,
            "unknownReferences": 0,
            "verifiedReuseEvidence": 0,
            "secondaryReuseEvidence": 0,
            "unknownReuseEvidence": 0,
            "unresolvedTerms": 0,
            "urlsReachable": 0,
            "urlsUnreachable": 0,
            "urlsUnverified": 0,
        })

    for resource in resources:
        bucket = group(resource["sourceGroup"])
        bucket["resources"] += 1
        reuse = resource["reuse"]
        bucket["{}ReuseEvidence".format(reuse["evidenceState"])] += 1
        if reuse["evidenceState"] == "unknown":
            bucket["unresolvedTerms"] += 1
        for ref in reuse.get("noticeReferences", []):
            bucket["{}References".format(ref["evidenceState"])] += 1
        for url in resource["source"]["urls"]:
            outcome = "unverified"
            if url_checks:
                for result in url_checks["results"]:
                    if result["resource"] == resource["id"] and result["url"] == url:
                        outcome = result["reachability"]
                        break
            if outcome == "reachable":
                bucket["urlsReachable"] += 1
            elif outcome == "unreachable":
                bucket["urlsUnreachable"] += 1
            else:
                bucket["urlsUnverified"] += 1

    totals = {key: sum(bucket[key] for bucket in groups.values())
              for key in next(iter(groups.values()), {})}
    return {
        "repo": REPO,
        "branch": BRANCH,
        "baseBranch": BASE_BRANCH,
        "countsScope": "per source group; evidence states describe what was observed, never permission",
        "groups": [dict(group_id=name, **counts) for name, counts in sorted(groups.items())],
        "totals": totals,
        "unresolvedTerms": [
            {"id": r["id"], "sourceGroup": r["sourceGroup"], "note": r.get("notes", "")}
            for r in resources if r["reuse"]["evidenceState"] == "unknown"
        ],
        "urlChecksRun": bool(url_checks),
    }


def write_summary_md(out_dir: Path, summary: Dict[str, Any]) -> None:
    lines = [
        "# Benchmark data attribution summary",
        "",
        "repo: {}  branch: {}  base: {}".format(
            summary["repo"], summary["branch"], summary["baseBranch"]),
        "",
        summary["countsScope"],
        "",
    ]
    header = ("| source group | resources | verified refs | secondary refs | unknown refs | "
              "verified reuse | secondary reuse | unknown reuse | unresolved terms |"
              " urls reachable | unreachable | unverified |")
    # One separator cell per header column, derived so the two cannot drift.
    lines += [header, "|" + "---|" * (header.count("|") - 1)]
    for group in summary["groups"]:
        lines.append(
            "| {group_id} | {resources} | {verifiedReferences} | {secondaryReferences} | {unknownReferences} | "
            "{verifiedReuseEvidence} | {secondaryReuseEvidence} | {unknownReuseEvidence} | {unresolvedTerms} | "
            "{urlsReachable} | {urlsUnreachable} | {urlsUnverified} |".format(**group)
        )
    totals = summary["totals"]
    lines += [
        "| **totals** | {resources} | {verifiedReferences} | {secondaryReferences} | {unknownReferences} | "
        "{verifiedReuseEvidence} | {secondaryReuseEvidence} | {unknownReuseEvidence} | {unresolvedTerms} | "
        "{urlsReachable} | {urlsUnreachable} | {urlsUnverified} |".format(**totals),
        "",
    ]
    if summary["unresolvedTerms"]:
        lines.append("## Unresolved terms")
        lines.append("")
        for term in summary["unresolvedTerms"]:
            lines.append("- **{}** ({}): {}".format(term["id"], term["sourceGroup"], term["note"]))
        lines.append("")
    lines.append("URL reachability is evidence about the network, never about permission.")
    (out_dir / "summary.md").write_text("\n".join(lines), encoding="utf-8")


# ------------------------------------------------------------------ main

def missing_inputs(root: Path) -> List[str]:
    return [rel for rel in REQUIRED_INPUTS if not exists(root, rel)]


def checkout_problems(root: Path) -> List[str]:
    """Every way this checkout's input files can differ from the recorded commits.

    Evidence is labeled with the parent HEAD and the committed submodule pins,
    so the generator refuses to run when the bytes it would read are not the
    committed ones: uncommitted input edits, a submodule not checked out, a
    submodule HEAD off its pin, or local submodule changes.
    """
    problems: List[str] = []
    links = gitlinks(root)
    for rel in REQUIRED_INPUTS:
        if any(rel.startswith(path + "/") for path in links):
            continue  # lives inside a submodule; checked with that submodule below
        state = git(root, "status", "--porcelain", "--", rel)
        if state:
            problems.append("{} is not committed at HEAD ({})".format(rel, state.splitlines()[0]))
    for path in sorted(links):
        work = root / path
        if not (work / ".git").exists():
            problems.append("submodule {} is not initialized; check it out at the pinned revision".format(path))
            continue
        try:
            actual = git(work, "rev-parse", "HEAD")
        except subprocess.CalledProcessError:
            problems.append("submodule {} has no readable HEAD".format(path))
            continue
        if actual != links[path]:
            problems.append("submodule {} is checked out at {} but the parent pins {}".format(
                path, actual[:12], links[path][:12]))
        if git(work, "status", "--porcelain"):
            problems.append("submodule {} has uncommitted changes".format(path))
    return problems


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Generate the benchmark data attribution inventory.")
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument("--root", default=None,
                        help="repository root (default: the parent of this tool directory)")
    parser.add_argument("--verify-urls", action="store_true",
                        help="run bounded read-only reachability checks against pinned URLs")
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])

    root = Path(args.root) if args.root else Path(__file__).resolve().parents[2]

    missing = missing_inputs(root)
    if missing:
        print("missing required committed inputs (are the benchmarks/week* submodules "
              "checked out?):", file=sys.stderr)
        for rel in missing:
            print("  - {}".format(rel), file=sys.stderr)
        return 2

    problems = checkout_problems(root)
    if problems:
        print("the checkout does not match the recorded commits; refusing to generate:",
              file=sys.stderr)
        for problem in problems:
            print("  - {}".format(problem), file=sys.stderr)
        return 3

    resources = build_resources(root)
    summary = summarize(resources, None)

    tool_dir = Path(__file__).resolve().parent
    if str(tool_dir) not in sys.path:
        sys.path.insert(0, str(tool_dir))
    import validate as validator  # noqa: E402 - sibling stdlib module

    inventory = {
        "schemaVersion": SCHEMA_VERSION,
        "schema": SCHEMA_REF,
        "repo": REPO,
        "branch": BRANCH,
        "baseBranch": BASE_BRANCH,
        "baseRevision": git(root, "rev-parse", "HEAD"),
        "sources": [
            {"path": rel, "sha256": sha256_bytes(read_bytes(root, rel))}
            for rel in sorted(CONSUMED_INPUTS)
            if exists(root, rel)
        ],
        "resources": resources,
    }
    errors = validator.validate(inventory, read_json(tool_dir, "schema/resources.schema.json"))
    if errors:
        print("inventory violates {} before write; refusing to write:".format(SCHEMA_REF),
              file=sys.stderr)
        for message in errors:
            print("  - {}".format(message), file=sys.stderr)
        return 1

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    dump_json(out_dir / "resources.json", inventory)
    dump_json(out_dir / "summary.json", summary)
    write_summary_md(out_dir, summary)

    if args.verify_urls:
        url_checks = verify_urls(root, resources)
        dump_json(out_dir / "url-checks.json", url_checks)
        summary = summarize(resources, url_checks)
        summary["baseRevision"] = url_checks["sourceRevision"]
        dump_json(out_dir / "summary.json", summary)
        write_summary_md(out_dir, summary)

    print("wrote resources.json, summary.json, summary.md{} to {}".format(
        ", url-checks.json" if args.verify_urls else "", out_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
