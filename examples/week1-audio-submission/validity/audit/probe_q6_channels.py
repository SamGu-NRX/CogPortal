"""Q6 probe — secondary channels: candidate-list truncation, output-record
fields, and clip-length cell classification, observed in one evaluation-tier
run through the real driver.
"""
import json
import sys

REPO = "/home/user/work/CogPortal"
sys.path.insert(0, REPO + "/benchmarks/week1")

from audio_identification_benchmark import datasets  # noqa: E402
from audio_identification_benchmark.contracts import Resources  # noqa: E402
from audio_identification_benchmark.drivers import KEEP_CANDIDATES, run_cases  # noqa: E402

manifest = datasets.load_manifest("evaluation")
cases = datasets.materialize_cases(manifest)
print(f"driver.KEEP_CANDIDATES = {KEEP_CANDIDATES}")

lengths = []


class Probe:
    def enroll(self, song_id, samples, sample_rate):
        pass

    def identify(self, samples, sample_rate):
        lengths.append(len(samples))
        # return 20 candidates to test the truncation depth
        return [("song-{:02d}".format(i % 30), 1.0 - i / 100.0) for i in range(20)]


def factory(resources):
    return Probe()


outputs = run_cases(factory, Resources(), cases)
print(f"\n=== A. KEEP_CANDIDATES truncation is observable in the output record ===")
q_out = [o for o in outputs if "candidates" in o]
print(f"submission returned 20 candidates; driver stored "
      f"{ {len(o['candidates']) for o in q_out} } (every record truncated to {KEEP_CANDIDATES})")
print(f"so the length of the stored list is a driver artifact, not the submission's depth")

print("\n=== B. output-record fields (what any diagnostic/report discloses) ===")
print("keys of a query output record:", sorted(q_out[0].keys()))
oos_out = [o for o in q_out if int(str(o["query_id"])[1:]) >= 240]
print(f"out-of-set records kept in outputs: {len(oos_out)}; ids: "
      f"{[str(o['query_id']) for o in oos_out]}")
print("per-record 'seconds' timing field, first 3 queries:",
      [(str(o['query_id']), o['seconds']) for o in q_out[:3]])

print("\n=== B2. provenance channel: student-set PROVENANCE reaches the run page ===")
# adapters.py: AdaptedIdentifier.provenance = getattr(target, "PROVENANCE", None);
# drivers.py: if provenance.get("source") != "student", the run page gets
# "scored through an instructor-supplied adapter; we supplied: ...".
# A submission can therefore put arbitrary text on the run page by declaring
# itself instructor-supplied. Demonstrate with a smoke run (one enroll case).


class ProvProbe(Probe):
    PROVENANCE = {"source": "instructor", "we_supplied": ["<arbitrary student text>"]}


def prov_factory(resources):
    return ProvProbe()


outputs2 = run_cases(prov_factory, Resources(), [cases[0]])  # enroll-only smoke
print("last output's 'mappings' after PROVENANCE spoof:",
      outputs2[-1].get("mappings"))

print("\n=== C. clip length alone classifies the cell ===")
import collections  # noqa: E402
hist = collections.Counter(lengths)
print(f"identify clip-length histogram over {len(lengths)} calls: {dict(hist)}")
print("expected from manifest clip_seconds: 10.0s clean/noisy/pitch (210 calls), "
      "5.0s short (30), 3.0s lowsnr (30)")
manifest_hist = collections.Counter(str(r["clip_seconds"]) for r in manifest["queries"])
print("manifest clip_seconds histogram:", dict(manifest_hist))
print(f"warm-up call was first and had length {lengths[0]}")
json.dump({"lengths": lengths}, open("/home/user/work/metadata-audit/probe_q6_lengths.json", "w"))
print("\nwrote probe_q6_lengths.json")
