"""Materialize the two public tiers through the frozen benchmark APIs, once."""
import json
from pathlib import Path

from facial_recognition_benchmark.datasets import cache_status, load_manifest, materialize_manifest
from language_search_benchmark.datasets import artifact_status, build_resources

root = Path(__file__).resolve().parent
for tier in ("test", "evaluation"):
    print("Preparing Vision " + tier, flush=True)
    manifest = load_manifest(tier)
    path = materialize_manifest(manifest, cache_root=root / "data/vision")
    status = cache_status(manifest, cache_root=root / "data/vision")
    print(json.dumps({"track": "vision", "tier": tier, "path": str(path), "ready": status.ready, "message": status.message}), flush=True)
print("Preparing Language artifacts and derived GloVe cache", flush=True)
resources = build_resources(download=True, build_kv=True)
status = artifact_status()
print(json.dumps({"track": "language", "ready": status.ready, "path": str(status.path), "message": status.message, "kv": str(resources.glove_kv_path)}), flush=True)
