# Real-audio arm — provenance and verification

The 14 openly reusable recordings (PD / CC0 / CC-BY / CC-BY-SA, all distinct
artists and source recordings, mono 44.1 kHz float32, 133–545 s each) are
**staged outside the repository** — about 745 MB of audio does not belong in
git. This directory carries the small, hash-pinned provenance files.

- `MANIFEST.json` — machine-readable track list (track ids, wav names,
  durations, licenses, sha256s of both the delivered WAV and its source).
- `LICENSES.md` — per-track source, license, verification date (2026-10-09),
  and sha256s.
- `verify.py` — standalone checker: re-verifies sha256, format, and duration
  for all 14 tracks (14 PASS / 0 FAIL at staging).

Staged set: `/home/user/work/real-audio-arm/` on the study sandbox (`tracks/`,
`MANIFEST.json`, `LICENSES.md`, `verify.py`; source originals are kept only on
the staging sandbox). The study runner consumes it with
`--real-dir /home/user/work/real-audio-arm/`; the runner re-checks 44100 Hz
and refuses anything else.

Two tracks are held out by the runner (highest sorted track ids) to supply
out-of-set queries; the rest enroll. Note: some source masters carry
inter-sample peaks up to 1.44 in float32; no gain was applied — clipping
cells are perturbation cells, not a property of the catalog.
