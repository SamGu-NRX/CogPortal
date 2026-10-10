#!/usr/bin/env python3
"""Re-verify every staged track: sha256 of original + WAV, sample rate, mono, float32, duration."""
import hashlib
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))

def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()

def main():
    m = json.load(open(os.path.join(BASE, "MANIFEST.json")))
    from scipy.io import wavfile
    import numpy as np
    npass = nfail = 0
    for t in m["tracks"]:
        checks = []
        orig = os.path.join(BASE, t["original_filename"])
        wav = os.path.join(BASE, t["wav_filename"])
        checks.append(("original exists", os.path.exists(orig)))
        if os.path.exists(orig):
            checks.append(("original sha256", sha256(orig) == t["sha256_original"]))
        checks.append(("wav exists", os.path.exists(wav)))
        ok = os.path.exists(wav)
        if ok:
            checks.append(("wav sha256", sha256(wav) == t["sha256_wav"]))
            try:
                fs, data = wavfile.read(wav)
                dur = data.shape[0] / fs
                checks.append(("sample_rate==44100", fs == 44100))
                checks.append(("float32", data.dtype == np.float32))
                checks.append(("mono", data.ndim == 1 or (data.ndim == 2 and data.shape[1] == 1)))
                checks.append(("duration>=90s", dur >= 90.0))
                checks.append(("duration matches manifest", abs(dur - t["duration_seconds"]) < 0.5))
            except Exception as e:  # noqa: BLE001
                checks.append(("wav readable", False))
                checks.append(("wav readable error", str(e)))
        passed = all(v for k, v in checks if isinstance(v, bool))
        status = "PASS" if passed else "FAIL"
        print(f"[{status}] {t['track_id']} - {t['title']} ({t['duration_seconds']}s)")
        if not passed:
            for k, v in checks:
                if v is False:
                    print(f"        FAILED: {k}")
            nfail += 1
        else:
            npass += 1
    print(f"\n{npass} PASS / {nfail} FAIL of {len(m['tracks'])} tracks")
    sys.exit(1 if nfail else 0)

if __name__ == "__main__":
    main()
