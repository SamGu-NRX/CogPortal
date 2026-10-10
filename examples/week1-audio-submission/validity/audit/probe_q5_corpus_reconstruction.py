"""Q5 probe — corpus reconstruction: a submission can re-render the entire
corpus from the manifest's per-song seeds and replicate the exact perturbation
pipeline (offset, pitch, snr, noise_seed), yielding a bit-exact hash-match
membership oracle over every query clip.

  1. render_from_manifest renders all 36 catalog songs (30 in-set + 6
     out-of-set), hash-verified against the manifest's per-song sha256.
  2. For every one of the 252 manifest query rows, rebuild the clip with
     synth.perturb and compare sha256 with the samples the scorer's own
     materialize_cases produced.
  3. Show a clean clip from an OUT-OF-SET song reproduces bit-exactly too,
     i.e. the whole id space is in the submission's renderable hash space.
"""
import sys
import time

REPO = "/home/user/work/CogPortal"
sys.path.insert(0, REPO + "/benchmarks/week1")

from audio_identification_benchmark import datasets, synth  # noqa: E402
from audio_identification_benchmark.datasets import QueryCase  # noqa: E402

print("=== A. render the full catalog from manifest seeds (hash-verified) ===")
manifest = datasets.load_manifest("evaluation")
specs = synth.specs_from_manifest(manifest["songs"])
in_set_songs = sum(1 for s in manifest["songs"] if int(str(s["song_id"]).split("-")[1]) < 30)
print(f"specs_from_manifest -> {len(specs)} SongSpec objects "
      f"({in_set_songs} in-set, {len(specs) - in_set_songs} out-of-set)")
t0 = time.time()
catalog, out_of_set = synth.render_from_manifest(manifest, verify=True)
catalog.update(out_of_set)
print(f"render_from_manifest(verify=True) -> {len(catalog)} songs in {time.time()-t0:.1f}s; "
      f"every render matched its manifest sha256")

print("\n=== B. bit-exact clip replication for all 252 queries ===")
cases = datasets.materialize_cases(manifest)
true_clips = {c.query_id: synth.sha256_signal(c.samples)
              for c in cases if isinstance(c, QueryCase)}
print(f"materialize_cases -> {len(true_clips)} query clips (scorer's own renders)")

match = 0
rows = manifest["queries"]
for row in rows:
    source = catalog[str(row["source_song_id"])]
    clip = synth.perturb(source, 44100, row["clip_seconds"], row["offset_seconds"],
                         row["pitch_semitones"], row["snr_db"], row["noise_seed"])
    if synth.sha256_signal(clip) == true_clips[str(row["query_id"])]:
        match += 1
print(f"sha256(rebuilt clip) == sha256(scorer's clip): {match}/{len(rows)}")

print("\n=== C. out-of-set songs are in the same renderable hash space ===")
oos_rows = [r for r in rows if not bool(r["in_set"])]
oos_match = sum(
    1 for row in oos_rows
    if synth.sha256_signal(synth.perturb(
        catalog[str(row["source_song_id"])], 44100, row["clip_seconds"],
        row["offset_seconds"], row["pitch_semitones"], row["snr_db"], row["noise_seed"]))
    == true_clips[str(row["query_id"])])
print(f"out-of-set query clips rebuilt bit-exactly: {oos_match}/{len(oos_rows)}")
oos_id = str(manifest["out_of_set_songs"][0]["song_id"])
song = catalog[oos_id]  # first out-of-set id
print(f"clean 10 s clip from out-of-set {oos_id} (offset 5.0, no perturbation) "
      f"hash: {synth.sha256_signal(song[int(5.0*44100):int(15.0*44100)])[:16]}... "
      f"- reproducible by any submission holding the manifest")
