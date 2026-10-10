"""Q4 probe — local cogbench path: submission discovery, import, and scoring
all happen in ONE process, and the scored tier carries plaintext gold.

Reenacts exactly what `cogbench run audio-identification` does
(cli._run_view -> cogbench.runner.execute -> runner._execute_v2) with the
same plugin class the `cogworks.benchmarks.v2` entry point resolves, against
the staff example repository (a submission.py at the repo root).
"""
import os
import sys
import time

REPO = "/home/user/work/CogPortal"
sys.path.insert(0, REPO + "/python/cogbench/src")
sys.path.insert(0, REPO + "/benchmarks/week1")

print("=== A. cogbench resolves a submission by file, in this process ===")
from cogbench.plugins import resolve_submission  # noqa: E402

os.chdir(REPO + "/examples/week1-audio-submission")
factory, source, detail = resolve_submission(
    "audio-identification", "cogworks.submissions.v2"
)
print(f"resolve_submission -> source={source!r} detail={detail!r}")
print("(the factory is the imported submission.py module; no subprocess, no isolation)")

print("\n=== B. the v2 execute path: gold-bearing cases, in-process run and score ===")
from cogbench.runner import execute  # noqa: E402
from audio_identification_benchmark.plugins import AudioIdentificationBenchmark  # noqa: E402

benchmark = AudioIdentificationBenchmark()
cases_probe = benchmark.load_cases("test")  # cheap tier, just to show gold fields
q = [c for c in cases_probe if type(c).__name__ == "QueryCase"]
print(f"benchmark.load_cases -> cases carry gold: "
      f"{sum(1 for c in q if c.gold_song_id)}/{len(q)} query cases have gold_song_id")

print("\n=== C. metadata-attack submission scored through the real local runner ===")
from audio_identification_benchmark import datasets  # noqa: E402


class OrderAttack:
    def __init__(self, resources):
        m = datasets.load_manifest("evaluation")
        self.answers = [str(r["source_song_id"]) for r in m["queries"] if bool(r["in_set"])]
        self.i = 0

    def enroll(self, song_id, samples, sample_rate):
        pass

    def identify(self, samples, sample_rate):
        if len(samples) == sample_rate and not samples.any():
            return []  # skip warm-up
        answer = self.answers[self.i]
        self.i += 1
        return [(answer, 1.0)]


t0 = time.time()
report = execute(benchmark, OrderAttack, os.getcwd(), smoke=False)
metrics = {m.key: m.value for m in report.metrics}
print(f"execute() -> LocalReport in {time.time()-t0:.1f}s")
print("tier scored: evaluation (runner._execute_v2 chooses 'test' if smoke else 'evaluation')")
print(f"identification_score = {metrics['identification_score']}")
print(f"clean_top1={metrics['clean_top1']} pitch_top1={metrics['pitch_top1']} "
      f"chance_top1={metrics['chance_top1']:.4f}")
