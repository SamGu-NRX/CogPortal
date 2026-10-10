"""Source hashes: the study measures specific bytes of process.py and
process-signals.ts. If either file drifts, every committed result is a
measurement of a different builder and must be re-frozen."""

import json

import pytest

from harness import HERE, PYTHON_SOURCE, TS_SOURCE, sha256_of

FROZEN = HERE / "frozen" / "source-hashes.json"


@pytest.fixture(scope="module")
def frozen():
    with open(FROZEN, "r", encoding="utf-8") as handle:
        return json.load(handle)


def test_python_builder_is_the_frozen_bytes(frozen):
    assert sha256_of(PYTHON_SOURCE) == frozen["python/cogbench/src/cogbench/process.py"]


def test_typescript_builder_is_the_frozen_bytes(frozen):
    assert sha256_of(TS_SOURCE) == frozen["apps/portal/worker/services/process-signals.ts"]


def test_frozen_file_names_both_builders(frozen):
    keys = {k for k in frozen if k != "note"}
    assert keys == {
        "python/cogbench/src/cogbench/process.py",
        "apps/portal/worker/services/process-signals.ts",
    }
