"""Sandbox payload for the Week 3 language benchmark.

The zip carries only what the submission needs to produce embeddings and
search results: caption texts, the descriptor pool, pool image ids, seeds,
and the showcase switch. Gold (text groups, retrieval rows, search image
ids) never enters the payload; the controller re-attaches it for scoring
with ``attach_gold``.
"""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any, Dict, List, Sequence, Tuple

import numpy as np

BENCHMARK_ID = "language-search"


def _verbatim_by_kind(cases: Sequence[Any]) -> Dict[str, Any]:
    """One case per kind, taking the verbatim search case.

    Several search cases share one kind, one per query rewrite. A plain
    by-kind dict keeps whichever came last, which would silently make a
    rewritten rung the scored component.
    """

    return {
        getattr(case, "kind", "?"): case
        for case in cases
        if getattr(case, "rung", "verbatim") == "verbatim"
    }


def encode_payload(benchmark_id: str, cases: Sequence[Any], showcase: bool) -> bytes:
    if benchmark_id != BENCHMARK_ID:
        raise ValueError("Unsupported Week 3 benchmark.")
    by_kind = _verbatim_by_kind(cases)
    text = by_kind["text"]
    retrieval = by_kind["retrieval"]
    search = by_kind["search"]
    if not np.array_equal(retrieval.descriptors, search.descriptors):
        raise ValueError("Retrieval and search pools must share one descriptor matrix.")
    metadata: Dict[str, Any] = {
        "benchmark_id": benchmark_id,
        "showcase": bool(showcase),
        "tie_break_seed": int(retrieval.tie_break_seed),
        "text_captions": list(text.captions),
        "queries": list(retrieval.queries),
        "pool_image_ids": [int(value) for value in search.image_ids],
        "search_k": int(search.k),
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("metadata.json", json.dumps(metadata, sort_keys=True))
        matrix = io.BytesIO()
        np.save(
            matrix,
            np.asarray(retrieval.descriptors, dtype=np.float32),
            allow_pickle=False,
        )
        archive.writestr("descriptors.npy", matrix.getvalue())
    return buffer.getvalue()


def decode_payload(payload: bytes) -> Tuple[str, bool, List[Any]]:
    """Rebuild the gold-free cases inside the sandbox, from the zip alone.

    The grid itself is the benchmark's, through `build_cases`. This module used
    to assemble it here as well, which is how the sandbox came to rebuild the
    search rewrites and not the retrieval ones and ran six cases against a
    nine-case tier. The order, the rung set and the pool-sharing rules are
    benchmark facts and live there now; what stays here is the transport.
    """

    from language_search_benchmark.datasets import build_cases

    with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
        metadata = json.loads(archive.read("metadata.json"))
        descriptors = np.load(
            io.BytesIO(archive.read("descriptors.npy")), allow_pickle=False
        )
    benchmark_id = str(metadata["benchmark_id"])
    if benchmark_id != BENCHMARK_ID:
        raise ValueError("Unsupported Week 3 benchmark payload.")

    cases = build_cases(
        text_captions=[str(value) for value in metadata["text_captions"]],
        queries=[str(value) for value in metadata["queries"]],
        pool_image_ids=[int(value) for value in metadata["pool_image_ids"]],
        pool_descriptors=np.asarray(descriptors, dtype=np.float32),
        tie_break_seed=int(metadata["tie_break_seed"]),
        search_k=int(metadata["search_k"]),
    )
    return benchmark_id, bool(metadata["showcase"]), cases


def extract_gold(cases: Sequence[Any]) -> Dict[str, List[int]]:
    """The controller-side gold record written to the official volume."""

    by_kind = _verbatim_by_kind(cases)
    text = by_kind["text"]
    retrieval = by_kind["retrieval"]
    search = by_kind["search"]
    if (
        text.group_rows is None
        or retrieval.gold_rows is None
        or search.gold_image_ids is None
    ):
        raise ValueError("Cases are already gold-free; nothing to extract.")
    return {
        "text_group_rows": [int(value) for value in text.group_rows],
        "retrieval_gold_rows": [int(value) for value in retrieval.gold_rows],
        "search_gold_image_ids": [int(value) for value in search.gold_image_ids],
    }
