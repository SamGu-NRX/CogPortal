"""Q1 probe — execution boundary: does a submission run in the scorer's process,
and can it read plaintext gold by importing the package?

Section A emulates a submission importing the package and printing gold ids.
Section D runs a gold-reading attack through the real driver
(drivers.run_cases) and scores it with the real scorer (metrics.score_outputs).

Runs against the pinned checkout at /home/user/work/CogPortal (read-only).
"""
import json
import sys
import time

REPO = "/home/user/work/CogPortal"
sys.path.insert(0, REPO + "/benchmarks/week1")

print("=== A. plaintext gold reachable from inside a submission process ===")

# This import is exactly what student code can do: the package is installed
# in the interpreter that runs submissions (locally via pip install -e
# benchmarks/week1; hosted via week1_image's venv pip install /opt/week1).
from audio_identification_benchmark import datasets  # noqa: E402
from audio_identification_benchmark.contracts import Resources  # noqa: E402
from audio_identification_benchmark.drivers import run_cases  # noqa: E402
from audio_identification_benchmark.metrics import score_outputs  # noqa: E402

t0 = time.time()
manifest = datasets.load_manifest("evaluation")
rows = manifest["queries"]
print(f"load_manifest('evaluation') -> {len(rows)} query rows, "
      f"{len(manifest['songs'])} songs, manifest_id={manifest['manifest_id']}")
print("first 3 rows as a submission sees them (plaintext gold):")
for row in rows[:3]:
    print("  ", json.dumps({k: row[k] for k in (
        "query_id", "source_song_id", "in_set", "cell", "clip_seconds",
        "offset_seconds", "pitch_semitones", "snr_db", "noise_seed")}))

print("\n=== B. materialize the corpus (what the scorer hands the driver) ===")
cases = datasets.materialize_cases(manifest)
queries = [c for c in cases if type(c).__name__ == "QueryCase"]
enrolls = [c for c in cases if type(c).__name__ == "EnrollCase"]
print(f"materialize_cases -> {len(enrolls)} enroll cases + {len(queries)} query cases "
      f"({time.time()-t0:.1f}s)")
in_set = [c for c in queries if c.kind == "in_set"]
print(f"in-set queries: {len(in_set)}; sample gold metadata on QueryCase objects:")
for c in in_set[:3]:
    print(f"   {c.query_id}: gold_song_id={c.gold_song_id!r} offset={c.offset_seconds} "
          f"noise_seed={c.noise_seed} source={c.source_song_id!r}")

print("\n=== C. gc channel: enumerate the scorer's own QueryCase objects ===")
import gc  # noqa: E402
from audio_identification_benchmark.datasets import QueryCase  # noqa: E402

found = [o for o in gc.get_objects() if isinstance(o, QueryCase) and o.kind == "in_set"]
print(f"gc walk from 'student-side' module scope found {len(found)} in-set "
      f"QueryCase objects belonging to the scorer's run")
for c in found[:2]:
    print(f"   {c.query_id}: gold_song_id={c.gold_song_id!r}")

print("\n=== D. attack run through drivers.run_cases + score_outputs ===")


class OrderAttack:
    """Metadata-only submission: imports the manifest, answers by call index."""

    def __init__(self, resources):
        m = datasets.load_manifest("evaluation")
        self.answers = [str(r["source_song_id"]) for r in m["queries"] if bool(r["in_set"])]
        self.i = 0
        self.skipped_warmup = False

    def enroll(self, song_id, samples, sample_rate):
        pass  # a metadata attack never builds a database

    def identify(self, samples, sample_rate):
        # The driver's warm-up is a 1-second zeros clip (drivers._warm_up);
        # detect and skip it so it cannot offset the call counter.
        if len(samples) == sample_rate and not samples.any():
            self.skipped_warmup = True
            return []
        answer = self.answers[self.i]
        self.i += 1
        return [(answer, 1.0)]  # list of (song_id, score) pairs


INSTANCE = {}

def factory(resources):
    INSTANCE['obj'] = OrderAttack(resources)
    return INSTANCE['obj']

outputs = run_cases(factory, Resources(), cases)
metrics, diag = score_outputs(outputs, cases, 5)
print(f"warm-up detected and skipped by zeros rule: {INSTANCE['obj'].skipped_warmup}; "
      f"query calls consumed: {INSTANCE['obj'].i} of {len(in_set)} in-set queries")
print(f"identification_score = {metrics['identification_score']}")
print(f"clean_top1={metrics['clean_top1']} noisy_top1={metrics['noisy_top1']} "
      f"short_clip_top1={metrics['short_clip_top1']} pitch_top1={metrics['pitch_top1']} "
      f"chance_top1={metrics['chance_top1']:.4f}")
