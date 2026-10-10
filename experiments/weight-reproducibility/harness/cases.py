"""Case families: the measurement matrix of the experiment.

Each case runs against tiny synthetic artifacts (``artifacts``) and returns
one record whose verdicts are committed in two separate sections by ``run.py``:

- receiptVerdicts: what the traced receipt/sync contracts say — the
  production ``validate_prepared_environment`` for the prepared-artifact
  layer, the ported store lookup for the storage layer. Accepted or refused,
  with the fixed reason.

- predictionVerdicts: what a deterministic stand-in model produces from the
  bytes a loader actually hands it, compared with the baseline prediction.

The thesis under test: a matching receipt proves internal consistency of the
recorded lineage. It does not prove the evaluator will see those bytes, nor
that they are the bytes any earlier lineage meant.
"""

from __future__ import annotations

import hashlib

from . import artifacts as A
from .loaders import Receipt, VerifyingLoader
from .store import StoreRefusal, WeightStore
from .cache import CacheStore

ARTIFACT_ID = "artifact-fixture-0001"
BASE_IMAGE = "image-fixture-0001"
MIXED_CASE_REPO = A.REPO.upper()


def _prepared(store: WeightStore, receipt: Receipt, weight_data: bytes) -> dict:
    """Prepare once: sync the weight into the store, bind a receipt."""
    record = A.weight_record(data=weight_data)
    store.put_content_addressed(A.REPO, A.SHA, record["path"], weight_data, record["sha256"])
    receipt.bind(A.job([record]), A.observation(), ARTIFACT_ID, BASE_IMAGE)
    return record


def _reuse_job(receipt: Receipt) -> dict:
    return A.job(receipt.weight_rows(), prepared_artifact_id=ARTIFACT_ID)


def _prediction(loader, record: dict, mutate: bytes | None = None) -> dict:
    try:
        data = loader.load(A.REPO, A.SHA, record)
    except StoreRefusal as error:
        return {"loaded": False, "refusal": str(error)}
    if mutate is not None:
        data = mutate
    return {"loaded": True, "score": A.predict({record["path"]: data})}


def _ledger_for(record: dict) -> list[dict]:
    return [
        {
            "kind": "weight-bytes",
            "path": record["path"],
            "claim": record["sha256"],
            "bytesHex": record["bytesHex"],
        }
    ]


# -- baseline ---------------------------------------------------------------


def baseline(prod) -> dict:
    store, receipt = WeightStore(), Receipt(prod)
    record = _prepared(store, receipt, A.BENIGN_WEIGHT)
    loader = VerifyingLoader(store)
    prediction = _prediction(loader, record)
    reuse_verdict = receipt.check_reuse(_reuse_job(receipt))
    return {
        "id": "baseline",
        "family": "baseline",
        "question": "Does the honest lineage pass every layer and reproduce the baseline score?",
        "receiptVerdicts": [
            {"layer": "storage", "status": "matched" if not prediction.get("refusal") else "refused"},
            {
                "layer": "prepared-receipt",
                "status": "accepted" if reuse_verdict is None else f"refused: {reuse_verdict}",
            },
        ],
        "predictionVerdicts": [
            {
                "loader": loader.name,
                **prediction,
                "baselineScore": prediction["score"],
                "diverged": False,
            },
        ],
        "digestLedger": _ledger_for({**record, "bytesHex": A.BENIGN_WEIGHT.hex()}),
    }


# -- same-size substitutions --------------------------------------------------


def substitution_store_refusal(prod) -> dict:
    """Same-size bytes swapped in behind a recorded digest, at the keys a
    recorded run can still be served from.

    The content-addressed key cannot hold them: its write is refused unless
    the bytes hash to the digest in the key. The legacy pre-digest key is
    mutable and can, so this is the only substitution that survives to a
    lookup — and the lookup must refuse it on the checksum."""
    store, receipt = WeightStore(), Receipt(prod)
    record = A.weight_record()
    receipt.bind(A.job([record]), A.observation(), ARTIFACT_ID, BASE_IMAGE)
    # A pre-digest-era upload that matched, then the same mutable key was
    # overwritten with same-size different bytes. No content-addressed object
    # exists: this lineage predates the digest-keyed scheme.
    store.put_legacy(A.REPO, A.SHA, record["path"], A.BENIGN_WEIGHT)
    store.put_legacy(A.REPO, A.SHA, record["path"], A.SUBSTITUTED_WEIGHT)
    locate = store.locate(A.REPO, A.SHA, record["path"], record["sha256"], record["size"])
    loader = VerifyingLoader(store)
    prediction = _prediction(loader, record)
    return {
        "id": "substitution-store-refusal",
        "family": "same-size-substitution",
        "question": "Can same-size substituted bytes behind a mutable key reach a loader?",
        "receiptVerdicts": [
            {"layer": "storage", "status": locate["status"], "detail": locate.get("reason")},
            {
                "layer": "prepared-receipt",
                "status": "accepted" if receipt.check_reuse(_reuse_job(receipt)) is None else "refused",
                "detail": "receipt compares recorded digests; it does not see the mutable key",
            },
        ],
        "predictionVerdicts": [{"loader": loader.name, **prediction}],
        "digestLedger": [
            {**_ledger_for({**record, "bytesHex": A.SUBSTITUTED_WEIGHT.hex()})[0],
             "kind": "corrupt-bytes-at-rest",
             "detail": "the receipt still records the honest digest; the bytes behind the mutable key no longer match it"},
        ],
    }


def substitution_receipt_consistent(prod) -> dict:
    """The substitution that every layer accepts: the lineage is honestly
    rebuilt around substituted bytes.

    A re-synced report uploads same-size different bytes with their own honest
    digest; a fresh artifact is prepared and bound from that report; every
    receipt check passes because the receipt records what this lineage
    requested. The prediction still diverges from the original lineage: the
    receipt proves consistency, not identity with what the first report meant."""
    store_a, receipt_a = WeightStore(), Receipt(prod)
    record_a = _prepared(store_a, receipt_a, A.BENIGN_WEIGHT)
    loader_a = VerifyingLoader(store_a)
    original = _prediction(loader_a, record_a)

    store_b, receipt_b = WeightStore(), Receipt(prod)
    record_b = _prepared(store_b, receipt_b, A.SUBSTITUTED_WEIGHT)
    loader_b = VerifyingLoader(store_b)
    substituted = _prediction(loader_b, record_b)
    reuse_verdict = receipt_b.check_reuse(_reuse_job(receipt_b))

    return {
        "id": "substitution-receipt-consistent",
        "family": "same-size-substitution",
        "question": "Does a receipt that matches substituted bytes still mean the original model?",
        "receiptVerdicts": [
            {
                "layer": "storage+receipt (lineage B)",
                "status": "matched" if substituted.get("loaded") else "refused",
                "detail": "same-size bytes synced with their own honest digest; "
                "fresh artifact bound from the re-synced report",
            },
            {
                "layer": "prepared-receipt",
                "status": "accepted" if reuse_verdict is None else f"refused: {reuse_verdict}",
            },
        ],
        "predictionVerdicts": [
            {
                "loader": loader_a.name,
                **original,
                "baselineScore": original["score"],
                "diverged": False,
            },
            {
                "loader": loader_b.name,
                **substituted,
                "baselineScore": original["score"],
                "diverged": substituted.get("score") != original.get("score"),
            },
        ],
        "digestLedger": [
            *_ledger_for({**record_a, "bytesHex": A.BENIGN_WEIGHT.hex()}),
            *_ledger_for({**record_b, "bytesHex": A.SUBSTITUTED_WEIGHT.hex()}),
        ],
    }


# -- aliases ------------------------------------------------------------------


def alias_repo_spelling(prod) -> dict:
    """Repository-name case is an alias storage resolves and the receipt does
    not. GitHub resolves names without case, so storage reads every spelling;
    the prepared-artifact receipt compares ``source.fullName`` exactly, so the
    same team spelled differently binds to nothing."""
    store, receipt = WeightStore(), Receipt(prod)
    record = _prepared(store, receipt, A.BENIGN_WEIGHT)
    # The object lives only under the lowercase spelling uploads write.
    locate_lower = store.locate(MIXED_CASE_REPO, A.SHA, record["path"], record["sha256"], record["size"])
    mixed_job = A.job(receipt.weight_rows(), prepared_artifact_id=ARTIFACT_ID)
    mixed_job["source"]["fullName"] = MIXED_CASE_REPO
    reuse_verdict = receipt.check_reuse(mixed_job)
    loader = VerifyingLoader(store)
    prediction = _prediction(loader, record)
    return {
        "id": "alias-repo-spelling",
        "family": "alias",
        "question": "Do storage aliases and the receipt agree on a case-spelled repository?",
        "receiptVerdicts": [
            {
                "layer": "storage (mixed-case lookup)",
                "status": locate_lower["status"],
                "detail": "spelling alias resolves to the lowercase object",
            },
            {
                "layer": "prepared-receipt",
                "status": "refused" if reuse_verdict else "accepted",
                "detail": reuse_verdict or "fullName compared exactly, no aliasing",
            },
        ],
        "predictionVerdicts": [
            {"loader": loader.name, **prediction, "diverged": False},
        ],
        "digestLedger": _ledger_for({**record, "bytesHex": A.BENIGN_WEIGHT.hex()}),
    }


def alias_path_spelling(prod) -> dict:
    """Path spellings are never normalized: a path that would have to be
    rewritten is refused before any lookup, so two spellings can never name
    one stored object."""
    store = WeightStore()
    record = A.weight_record()
    store.put_content_addressed(A.REPO, A.SHA, record["path"], A.BENIGN_WEIGHT, record["sha256"])
    attempted = []
    for bad in ("artifacts//model.bin", "artifacts/./model.bin", "../outside/model.bin"):
        try:
            store.locate(A.REPO, A.SHA, bad, record["sha256"], record["size"])
            attempted.append({"path": bad, "status": "matched"})
        except StoreRefusal as error:
            attempted.append({"path": bad, "status": "refused", "detail": str(error)})
    loader = VerifyingLoader(store)
    prediction = _prediction(loader, record)
    return {
        "id": "alias-path-spelling",
        "family": "alias",
        "question": "Can a respelled path reach another path's object?",
        "receiptVerdicts": [
            {"layer": "storage", "status": row["status"], "detail": row.get("detail"), "path": row["path"]}
            for row in attempted
        ],
        "predictionVerdicts": [
            {"loader": loader.name, **prediction, "diverged": False},
        ],
        "digestLedger": _ledger_for({**record, "bytesHex": A.BENIGN_WEIGHT.hex()}),
    }


def alias_digest_keys(prod) -> dict:
    """The digest is a key segment: two digests at one path are two objects,
    and a lookup for one never serves the other."""
    store = WeightStore()
    benign = A.weight_record()
    substituted = A.weight_record(data=A.SUBSTITUTED_WEIGHT)
    store.put_content_addressed(A.REPO, A.SHA, benign["path"], A.BENIGN_WEIGHT, benign["sha256"])
    store.put_content_addressed(
        A.REPO, A.SHA, substituted["path"], A.SUBSTITUTED_WEIGHT, substituted["sha256"]
    )
    locate_benign = store.locate(A.REPO, A.SHA, benign["path"], benign["sha256"], benign["size"])
    locate_sub = store.locate(
        A.REPO, A.SHA, substituted["path"], substituted["sha256"], substituted["size"]
    )
    return {
        "id": "alias-digest-keys",
        "family": "alias",
        "question": "Can one path's two digests alias each other's bytes?",
        "receiptVerdicts": [
            {"layer": "storage (digest D1)", "status": locate_benign["status"]},
            {"layer": "storage (digest D2)", "status": locate_sub["status"]},
        ],
        "predictionVerdicts": [],
        "digestLedger": [
            *_ledger_for({**benign, "bytesHex": A.BENIGN_WEIGHT.hex()}),
            *_ledger_for({**substituted, "bytesHex": A.SUBSTITUTED_WEIGHT.hex()}),
        ],
    }


# -- missing and partial files -------------------------------------------------


def missing_weight(prod) -> dict:
    store, receipt = WeightStore(), Receipt(prod)
    record = _prepared(store, receipt, A.BENIGN_WEIGHT)
    empty = WeightStore()
    locate = empty.locate(A.REPO, A.SHA, record["path"], record["sha256"], record["size"])
    loader = VerifyingLoader(empty)
    prediction = _prediction(loader, record)
    return {
        "id": "missing-weight",
        "family": "missing-partial",
        "question": "What happens when the recorded weight is nowhere in storage?",
        "receiptVerdicts": [
            {"layer": "storage", "status": locate["status"]},
            {
                "layer": "prepared-receipt",
                "status": "accepted",
                "detail": "artifact availability is deliberately not a receipt check; "
                "the dispatch path refuses instead",
            },
        ],
        "predictionVerdicts": [{"loader": loader.name, **prediction}],
        "digestLedger": _ledger_for({**record, "bytesHex": A.BENIGN_WEIGHT.hex()}),
    }


def partial_truncated_object(prod) -> dict:
    """An object truncated after publication: size drift fails first, and the
    checksum no longer matches either. Refused, never skipped to a legacy key."""
    store, receipt = WeightStore(), Receipt(prod)
    record = _prepared(store, receipt, A.BENIGN_WEIGHT)
    key = store.stored_keys(A.REPO, A.SHA, record["path"], record["sha256"])[0]
    store.truncate(key, keep=A.WEIGHT_SIZE // 2)
    locate = store.locate(A.REPO, A.SHA, record["path"], record["sha256"], record["size"])
    loader = VerifyingLoader(store)
    prediction = _prediction(loader, record)
    return {
        "id": "partial-truncated-object",
        "family": "missing-partial",
        "question": "Does a half-published object ever serve as a run's weight?",
        "receiptVerdicts": [
            {"layer": "storage", "status": locate["status"], "detail": locate.get("reason")},
            {
                "layer": "prepared-receipt",
                "status": "accepted",
                "detail": "same scope note as the missing case",
            },
        ],
        "predictionVerdicts": [{"loader": loader.name, **prediction}],
        "digestLedger": _ledger_for({**record, "bytesHex": A.BENIGN_WEIGHT.hex()}),
    }


def partial_upload_short(prod) -> dict:
    """A client that publishes bytes which do not hash to the digest it
    declared: the write itself is refused, so nothing is left to find."""
    store = WeightStore()
    record = A.weight_record()
    try:
        store.put_content_addressed(
            A.REPO, A.SHA, record["path"], A.SUBSTITUTED_WEIGHT, record["sha256"]
        )
        write_refused = False
    except StoreRefusal as error:
        write_refused = True
        refusal = str(error)
    locate = store.locate(A.REPO, A.SHA, record["path"], record["sha256"], record["size"])
    return {
        "id": "partial-upload-short",
        "family": "missing-partial",
        "question": "Can bytes that do not match their declared digest be published at all?",
        "receiptVerdicts": [
            {
                "layer": "storage (publication)",
                "status": "refused" if write_refused else "accepted",
                "detail": refusal if write_refused else "write accepted",
            },
            {"layer": "storage (later lookup)", "status": locate["status"]},
        ],
        "predictionVerdicts": [],
        "digestLedger": [
            *_ledger_for({**record, "bytesHex": A.BENIGN_WEIGHT.hex()}),
            {**_ledger_for({**record, "bytesHex": A.SUBSTITUTED_WEIGHT.hex()})[0],
             "kind": "refused-upload",
             "detail": "digest the client declared vs the bytes it offered; the write was refused, nothing rests anywhere"},
        ],
    }


# -- changed loaders -------------------------------------------------------------


def changed_loader_bypass(prod) -> dict:
    """A loader that stops re-deriving bytes from the recorded digest turns
    storage corruption into silent divergence.

    The recorded content-addressed object is truncated at rest. The verifying
    loader refuses on size and digest. A loader that only fetches the key's
    bytes — locate and rehash both gone — serves the truncated bytes, the
    receipt (which never observes loading) still accepts, and the prediction
    diverges. Nothing in the receipt layer notices."""
    store, receipt = WeightStore(), Receipt(prod)
    record = _prepared(store, receipt, A.BENIGN_WEIGHT)
    key = store.stored_keys(A.REPO, A.SHA, record["path"], record["sha256"])[0]
    store.truncate(key, keep=A.WEIGHT_SIZE // 2)

    verifying = VerifyingLoader(store)

    class BypassLoader(VerifyingLoader):
        name = "bypass-no-verify"

        def load(self, repo: str, sha: str, weight: dict) -> bytes:
            obj = self.store.head(key)
            return obj.data

    bypass = BypassLoader(store)
    reuse_verdict = receipt.check_reuse(_reuse_job(receipt))
    verifying_prediction = _prediction(verifying, record)
    bypass_prediction = _prediction(bypass, record)
    return {
        "id": "changed-loader-bypass",
        "family": "changed-loader",
        "question": "What does a loader that skips verification cost, given the same receipts?",
        "receiptVerdicts": [
            {
                "layer": "prepared-receipt",
                "status": "accepted" if reuse_verdict is None else f"refused: {reuse_verdict}",
                "detail": "the receipt layer does not observe which loader runs",
            },
        ],
        "predictionVerdicts": [
            {"loader": verifying.name, **verifying_prediction},
            {
                "loader": bypass.name,
                **bypass_prediction,
                "divergedFromBaseline": bypass_prediction.get("loaded") is True
                and bypass_prediction.get("score") != A.predict({record["path"]: A.BENIGN_WEIGHT}),
                "diverged": bypass_prediction.get("loaded") is True,
            },
        ],
        "digestLedger": [
            *_ledger_for({**record, "bytesHex": A.BENIGN_WEIGHT.hex()}),
            {
                "kind": "corrupt-bytes-at-rest",
                "path": record["path"],
                "claim": record["sha256"],
                "bytesHex": A.BENIGN_WEIGHT[: A.WEIGHT_SIZE // 2].hex(),
                "note": "claim is the recorded digest; recheck must fail for these bytes",
            },
        ],
    }


# -- state mutation after load ---------------------------------------------------


def state_mutation_after_load(prod) -> dict:
    """Bytes verified at load, then mutated in memory before prediction.

    Every digest check passes: the loader verified the bytes, the receipt
    matches, storage holds exactly what it bound. The mutation happens after
    all of them, in the one place none of the layers observe."""
    store, receipt = WeightStore(), Receipt(prod)
    record = _prepared(store, receipt, A.BENIGN_WEIGHT)
    loader = VerifyingLoader(store)
    loaded = bytearray(loader.load(A.REPO, A.SHA, record))
    faithful = A.predict({record["path"]: bytes(loaded)})
    loaded[0] ^= 0xFF
    mutated = A.predict({record["path"]: bytes(loaded)})
    reuse_verdict = receipt.check_reuse(_reuse_job(receipt))
    return {
        "id": "state-mutation-after-load",
        "family": "state-mutation",
        "question": "Does a passing receipt say anything about bytes after load?",
        "receiptVerdicts": [
            {
                "layer": "prepared-receipt",
                "status": "accepted" if reuse_verdict is None else f"refused: {reuse_verdict}",
            },
            {"layer": "storage", "status": "matched"},
        ],
        "predictionVerdicts": [
            {
                "loader": loader.name,
                "loaded": True,
                "score": faithful,
                "baselineScore": faithful,
                "diverged": False,
            },
            {
                "loader": loader.name,
                "loaded": True,
                "score": mutated,
                "baselineScore": faithful,
                "diverged": mutated != faithful,
                "detail": "one byte flipped in memory after load; every receipt still matches",
            },
        ],
        "digestLedger": _ledger_for({**record, "bytesHex": A.BENIGN_WEIGHT.hex()}),
    }


# -- cache publication ---------------------------------------------------------


def cache_publication(prod=None) -> dict:
    """Weight-derived caches share the storage contract's serve-or-refuse
    rule, including interrupted publications.

    A complete publication is served; a payload written without an index, an
    unsealed index, a tampered payload, and an index without a payload are all
    refused — never skipped and never trusted. The same recheck rule the
    weights use applies here: refusal is the answer, silence is not."""
    store = CacheStore()
    store.publish("cache/complete", b"a complete render corpus")
    store.publish_interrupted_payload_only("cache/payload-only", b"half written")
    store.publish_interrupted_unsealed("cache/unsealed", b"half written")
    tampered = store.publish("cache/tampered", b"honest bytes")
    store.payloads["cache/tampered"] = b"tampered bytes"
    store.publish("cache/index-only", b"bytes")
    del store.payloads["cache/index-only"]
    interrupted = {"interrupted (payload only)", "interrupted (unsealed index)"}
    lookups = {
        "complete": store.resolve("cache/complete"),
        "interrupted (payload only)": store.resolve("cache/payload-only"),
        "interrupted (unsealed index)": store.resolve("cache/unsealed"),
        "payload tampered after publish": store.resolve("cache/tampered"),
        "index without payload": store.resolve("cache/index-only"),
        "never published": store.resolve("cache/absent"),
    }
    return {
        "id": "cache-publication",
        "family": "cache-publication",
        "question": "Can an interrupted or tampered cache publication ever be served?",
        "receiptVerdicts": [
            {
                "layer": layer,
                "status": verdict["status"],
                "detail": verdict.get("reason"),
                "interrupted": layer in interrupted,
            }
            for layer, verdict in lookups.items()
        ],
        "predictionVerdicts": [],
        "digestLedger": [
            {
                "kind": "weight-bytes",
                "path": "cache/complete",
                "claim": hashlib.sha256(b"a complete render corpus").hexdigest(),
                "bytesHex": b"a complete render corpus".hex(),
            },
            {
                "kind": "corrupt-bytes-at-rest",
                "path": "cache/tampered",
                "claim": tampered["digest"],
                "bytesHex": b"tampered bytes".hex(),
                "detail": "payload swapped after publish; the index still records the honest digest",
            },
        ],
    }


FAMILIES = (
    baseline,
    substitution_store_refusal,
    substitution_receipt_consistent,
    alias_repo_spelling,
    alias_path_spelling,
    alias_digest_keys,
    missing_weight,
    partial_truncated_object,
    partial_upload_short,
    changed_loader_bypass,
    state_mutation_after_load,
    cache_publication,
)
