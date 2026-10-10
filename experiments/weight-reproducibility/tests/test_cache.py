"""Cache publication integrity in owned storage, including the interrupted
publications the replay milestone must keep refusing."""

from __future__ import annotations

from harness.cache import CacheStore


def test_complete_publish_serves():
    store = CacheStore()
    payload = b"rendered corpus"
    index = store.publish("cache/key", payload)
    resolved = store.resolve("cache/key")
    assert resolved["status"] == "matched" and resolved["digest"] == index["digest"]


def test_interrupted_payload_only_is_refused():
    store = CacheStore()
    store.publish_interrupted_payload_only("cache/key", b"half written")
    assert store.resolve("cache/key")["status"] == "refused"


def test_interrupted_unsealed_index_is_refused():
    store = CacheStore()
    store.publish_interrupted_unsealed("cache/key", b"half written")
    assert store.resolve("cache/key")["status"] == "refused"


def test_tampered_payload_after_publish_is_refused():
    store = CacheStore()
    store.publish("cache/key", b"honest bytes")
    store.payloads["cache/key"] = b"tampered bytes"
    resolved = store.resolve("cache/key")
    assert resolved["status"] == "refused" and "do not hash" in resolved["reason"]


def test_index_without_payload_is_refused():
    store = CacheStore()
    store.publish("cache/key", b"bytes")
    del store.payloads["cache/key"]
    assert store.resolve("cache/key")["status"] == "refused"


def test_missing_entry_is_missing():
    assert CacheStore().resolve("cache/absent")["status"] == "missing"
