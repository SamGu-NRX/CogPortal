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
from dataclasses import replace
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
    """Rebuild the three cases, gold-free, inside the sandbox."""

    from language_search_benchmark.datasets import RetrievalCase, SearchCase, TextCase

    with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
        metadata = json.loads(archive.read("metadata.json"))
        descriptors = np.load(
            io.BytesIO(archive.read("descriptors.npy")), allow_pickle=False
        )
    benchmark_id = str(metadata["benchmark_id"])
    if benchmark_id != BENCHMARK_ID:
        raise ValueError("Unsupported Week 3 benchmark payload.")
    seed = int(metadata["tie_break_seed"])
    cases: List[Any] = [
        TextCase(
            kind="text",
            captions=[str(value) for value in metadata["text_captions"]],
            group_rows=None,
            tie_break_seed=seed,
        ),
        RetrievalCase(
            kind="retrieval",
            queries=[str(value) for value in metadata["queries"]],
            descriptors=np.asarray(descriptors, dtype=np.float32),
            gold_rows=None,
            tie_break_seed=seed,
        ),
        SearchCase(
            kind="search",
            queries=[str(value) for value in metadata["queries"]],
            image_ids=[int(value) for value in metadata["pool_image_ids"]],
            descriptors=np.asarray(descriptors, dtype=np.float32),
            gold_image_ids=None,
            k=int(metadata["search_k"]),
            tie_break_seed=seed,
        ),
    ]

    # The rung queries are regenerated here rather than shipped. Each rewrite
    # is a pure function of the caption and its position, so the sandbox
    # derives byte-identical queries from what it already has, and the payload
    # does not grow by one full query list per rung.
    from language_search_benchmark import perturb

    queries = [str(value) for value in metadata["queries"]]
    for rung in perturb.RUNGS:
        if rung == "verbatim":
            continue
        cases.append(
            SearchCase(
                kind="search",
                queries=perturb.rewrite_all(queries, rung),
                image_ids=[int(value) for value in metadata["pool_image_ids"]],
                descriptors=np.asarray(descriptors, dtype=np.float32),
                gold_image_ids=None,
                k=int(metadata["search_k"]),
                tie_break_seed=seed,
                rung=rung,
            )
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


def attach_gold(cases: Sequence[Any], gold: Dict[str, Sequence[int]]) -> List[Any]:
    by_kind = _verbatim_by_kind(cases)
    text = by_kind["text"]
    retrieval = by_kind["retrieval"]
    search = by_kind["search"]
    # Every rung shares the verbatim case's gold: the rewrites change the
    # query text and nothing about which image is correct.
    rungs = [c for c in cases if getattr(c, "rung", "verbatim") != "verbatim"]
    group_rows = [int(value) for value in gold["text_group_rows"]]
    gold_rows = [int(value) for value in gold["retrieval_gold_rows"]]
    gold_ids = [int(value) for value in gold["search_gold_image_ids"]]
    if len(group_rows) != len(text.captions):
        raise ValueError("Gold text groups do not match the caption count.")
    if len(gold_rows) != len(retrieval.queries) or len(gold_ids) != len(search.queries):
        raise ValueError("Gold rows do not match the query count.")
    return [
        replace(text, group_rows=group_rows),
        replace(retrieval, gold_rows=gold_rows),
        replace(search, gold_image_ids=gold_ids),
    ] + [replace(case, gold_image_ids=gold_ids) for case in rungs]
