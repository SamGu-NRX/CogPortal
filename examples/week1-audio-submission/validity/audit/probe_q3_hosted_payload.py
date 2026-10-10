"""Q3 probe — hosted sandbox: what the job payload lets a submission recover.

Simulates the hosted week1 flow on the evaluation-tier manifest:
  1. controller: encode_payload(manifest)  (what _evaluate_week1 writes to
     /tmp/cog-week1-payload.zip in the sandbox)
  2. student process: read the payload zip, decode metadata.json, and recover
     every query's gold by inverting the source tokens against the catalog
     ids the submission already knows from its own enroll() calls.

Then re-renders one query clip from payload metadata alone and shows it is
bit-identical to the real corpus clip (seeds + perturbation params travel).
"""
import importlib.util
import io
import json
import sys
import zipfile

REPO = "/home/user/work/CogPortal"
sys.path.insert(0, REPO + "/benchmarks/week1")

from audio_identification_benchmark import datasets, synth  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "week1_payload", REPO + "/apps/runner-modal/src/cogworks_runner/week1_payload.py"
)
w1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w1)

print("=== A. controller side: build the payload the sandbox receives ===")
manifest = datasets.load_manifest("evaluation")
payload = w1.encode_payload("audio-identification", manifest, showcase=True)
print(f"encode_payload -> {len(payload)} bytes")

print("\n=== B. student side: read /tmp/cog-week1-payload.zip and invert the tokens ===")
with zipfile.ZipFile(io.BytesIO(payload)) as z:
    metadata = json.loads(z.read("metadata.json"))
print("metadata.json keys:", sorted(metadata.keys()))
print("salt in payload:", metadata["salt"])
print("first catalog song row:", metadata["songs"][0])
print("first query row:", metadata["queries"][0])

# The submission knows every catalog song_id because enroll() told it.
catalog_ids = [row["song_id"] for row in metadata["songs"]]
token_of = {w1._token(metadata["salt"], s): s for s in catalog_ids}
print(f"token table built from salt + {len(catalog_ids)} known song ids")

recovered, in_set_hit, total = {}, 0, 0
for row in metadata["queries"]:
    token = row["source_token"]
    song = token_of.get(token)
    recovered[str(row["query_id"])] = song
    if song is not None:
        in_set_hit += 1
    total += 1
print(f"token inversion: {in_set_hit}/{total} queries resolved to an enrolled song id")

print("\n=== C. check the recovery against the true (controller-side) gold ===")
truth = {str(r["query_id"]): str(r["source_song_id"])
         for r in manifest["queries"] if bool(r["in_set"])}
match = sum(1 for qid, gold in truth.items() if recovered.get(qid) == gold)
print(f"recovered gold matches the true manifest gold for {match}/{len(truth)} in-set queries")

print("\n=== D. clip re-render from payload metadata alone is bit-exact ===")
catalog = synth.render_corpus(synth.specs_from_manifest(metadata["songs"]), 44100, verify=True)
row = metadata["queries"][0]
source = catalog[token_of[row["source_token"]]]
clip = synth.perturb(source, 44100, row["clip_seconds"], row["offset_seconds"],
                     row["pitch_semitones"], row["snr_db"], row["noise_seed"])
# The full manifest names the same query's source; render from there.
true_row = next(r for r in manifest["queries"] if str(r["query_id"]) == str(row["query_id"]))
true_spec = next(s for s in manifest["songs"] if s["song_id"] == true_row["source_song_id"])
true_catalog = synth.render_corpus(synth.specs_from_manifest([true_spec]), 44100, verify=True)
true_clip = synth.perturb(true_catalog[true_row["source_song_id"]], 44100,
                          true_row["clip_seconds"], true_row["offset_seconds"],
                          true_row["pitch_semitones"], true_row["snr_db"], true_row["noise_seed"])
same = synth.sha256_signal(clip) == synth.sha256_signal(true_clip)
print(f"payload-rendered clip == manifest-rendered clip: {same}")
print(f"sha256: {synth.sha256_signal(clip)}")
