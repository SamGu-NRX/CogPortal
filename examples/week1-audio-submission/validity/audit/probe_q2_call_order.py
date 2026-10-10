"""Q2 probe — call-order leakage: the exact deterministic call sequence the
driver presents, and gold recovery from the identify call index alone.

Uses a spying adapter (no manifest import) to record the driver's call
sequence on the TEST tier, then proves the index->gold map for the EVALUATION
tier from the manifest's row order alone (what the driver is handed).
"""
import json
import sys

REPO = "/home/user/work/CogPortal"
sys.path.insert(0, REPO + "/benchmarks/week1")

import numpy as np  # noqa: E402

from audio_identification_benchmark import datasets  # noqa: E402
from audio_identification_benchmark.contracts import Resources  # noqa: E402
from audio_identification_benchmark.drivers import run_cases  # noqa: E402

print("=== A. observed call order on the test tier (spy adapter) ===")
manifest = datasets.load_manifest("test")
cases = datasets.materialize_cases(manifest)

log = []


class Spy:
    def enroll(self, song_id, samples, sample_rate):
        log.append(("enroll", song_id, len(samples)))

    def identify(self, samples, sample_rate):
        log.append(("identify", len(samples), bool(np.all(samples == 0.0))))
        return []


def factory(resources):
    return Spy()


run_cases(factory, Resources(), cases)
n_enroll = sum(1 for e in log if e[0] == "enroll")
print(f"first 3 calls: {log[:3]}")
print(f"warm-up call (first identify): {log[n_enroll]}")
print(f"calls after warm-up, first 5: {log[n_enroll + 1:n_enroll + 6]}")
print(f"total calls: {len(log)} = {n_enroll} enroll + 1 warm-up + "
      f"{len(log) - n_enroll - 1} identify")

print("\n=== B. gold from identify index alone, evaluation tier (no audio used) ===")
m = datasets.load_manifest("evaluation")
queries = m["queries"]
in_set = [r for r in queries if bool(r["in_set"])]
n = len(m["songs"])  # the submission learns this from its own enroll calls
print(f"evaluation tier: {len(queries)} queries, {len(in_set)} in-set, {n} enrolled songs")
ok = 0
for k, row in enumerate(in_set):
    predicted = "song-{:02d}".format(k % n)
    if predicted == row["source_song_id"]:
        ok += 1
print(f"index->gold rule 'song-{{k % {n}:02d}}': {ok}/{len(in_set)} in-set queries correct")

# cell-block layout: which identify indices are which cell
blocks = []
for start in range(0, len(in_set), n):
    blocks.append((start, in_set[start]["cell"]))
print("cell blocks (in-set index ranges):", blocks)
oos = [(i, r["query_id"]) for i, r in enumerate(queries) if not bool(r["in_set"])]
print(f"out-of-set indices (never scored): {oos}")
json.dump({"observed_calls": [list(e) for e in log]},
          open("/home/user/work/metadata-audit/probe_q2_calls.json", "w"))
print("\nwrote probe_q2_calls.json")
