# Real Audio course journey on dd7afb9

For root and the SDK/source-provenance owners. Actual local check, scoring, saved report, authenticated sync and native result inspection passed. One producer/consumer mismatch blocks continuing a fresh CLI result through Verify here. No hosted or Discord acceptance is claimed.

Frozen portal: `dd7afb9c5589108cfb2718956ebcfe1409813125`.
Student project: `SamGu-NRX/cogportal-demo-week1` at `71258046e60fecd3295c0b52236fc6e476b0e9cf`.
SDK: `1b7fc261abfe0ff006a4a678d936e75002e5bb39`.
Audio benchmark: `b156644aecc810e0b93535e320098f96c39ae04e`.

## Finding

**P2: the current CLI produces fresh local runs that can never offer Verify here.** The actual new local console `surface_457995925897d22e6c4b` reports success at the correct repository/SHA but says “This run predates the repository CogPortal records” and asks for another fresh run. No Verify here control appears. [Native tablet evidence](live-result-768.png), [full DOM](live-result.txt).

The pinned SDK's `python/cogbench/src/cogbench/project.py:42` always sets repository_id=None. `apps/portal/worker/routes/local-runs.ts:302` stores that supplied null unchanged. `worker/services/run-surfaces.ts:335` calls `runSourceRefusal`; `worker/services/run-source.ts:26-29` refuses every null recorded ID, regardless of matching full name/SHA or the connected team's ID. The saved session proves null repository_id alongside the exact real name and commit. Thus another run of this same pinned CLI cannot satisfy the suggested remedy. The private team used a null repository ID too, but changing only its ID would not satisfy this predicate. Do not weaken provenance or fabricate an ID as a verifier workaround; the current owners need to reconcile the producer and consumer. Root was notified during the pass.

## Installed course environment

Read the prior successful `verification-finalization/ui-e8aed6e/real-check.txt` and installed-identities.json first. A new disposable venv used Python3.11.15 and read-only dependency paths from the retained course environment. PYTHONDONTWRITEBYTECODE was set, with Numba and Matplotlib caches directed into this pass's disposable directory. The retained `.venv-ui-accept` was not upgraded. Its SDK remains094a6f1a.

The new venv installed the exact wheel built by the earlier real GitHub VCS installation of1b7fc261. Its SHA256 matches that recorded build, `4e35a5b535f8a70e0467d2f462218a848ef570059351be0daf41ea7f23a3f08c`. All22 imported SDK Python modules byte-match1b7fc261. The imported Audio package's direct_url recordsb156644, and all17 package source/manifest files byte-match that commit. [Installed identities](installed-identities.json), [Audio byte comparison](benchmark-source-match.json). No benchmark download, model corpus or large cache rebuild was needed; Audio uses shipped public manifests and synthesis.

Measured scientific packages were numpy1.24.4, scipy1.10.1, matplotlib3.7.5, numba0.58.1, librosa0.11.0 and soundfile0.12.1. This is the existing working local scientific environment, not a new exact recreation of every requirements.txt pin. Local execution is Python3.11.15; hosted Audio's3.8.20 remains a separate compatibility/hosted boundary.

The student checkout was cloned locally with independent Git objects into an owned disposable directory, kept on main at the exact7125804 commit, with its original GitHub origin metadata. The retained checkout stayed clean and unchanged. No GitHub push occurred.

## Completed journey

- The installed SDK read17 actual student files and wired `create_spectogram.create_spectrogram`, `find_peaks.find_peaks`, `create_fingerprints.peaks_to_fingerprints`, `database.AudioDatabase().store_fingerprints` and `.query`. Check exited0. Only the unrelated Flask frontend was unreadable, and one microphone/file-dependent script was skipped. No adapter or student implementation was fabricated. [Check](check.txt).
- Real installed CLI device linking completed against the private local portal. Running `cogworks check --benchmark audio-identification --update-setup` then returned `setup: updated clone, environment, project, wiring`. The database records all four as source=cli, with the three benchmark-specific steps scoped to Audio. Device linking supplied the fifth verified step. Helium showed5 of5, all labeled verified, and retained it after navigation/reload. No manual signed check-offs were used in this phase. [Reloaded setup](setup-reloaded.txt), [phone capture](setup-reloaded-390.png), [database evidence](integration-proof.json).
- `cogworks run --benchmark audio-identification --update-setup` exited0 in23.17 seconds, scored0.5375 and saved `local_ad2343f2e0c94802bc7a36338b5c896b`. The report names the exact7125804 SHA, main source and clean workspace. Explicit installed `cogworks sync` exited0 and labeled it LOCAL · SELF-REPORTED. Helium's local-report row showed7125804 and0.5375. [Run output](fresh-run.txt), [saved report](fresh-report.json), [sync](sync.txt), [native synced row](synced-score-768.png). The phone table scrolls horizontally, so the tablet image is the complete row evidence.
- Ordinary sync exposes a summary row. To inspect the local console as well, a second actual run used `--live --portal http://localhost:5218`. It exited0 in23.43 seconds and also scored0.5375. It produced session `localrun_de981531853c457995925897d22e6c4b`, report `local_80f81c268c90464fa0279c6d028e4169` and console `surface_457995925897d22e6c4b`. The CLI transmitted actual progress and its completed report to the local Worker. Helium showed282/282 evaluation cases, Run complete, Local complete, and Hosted/Official/Published pending, with the correct clean source. [CLI output](live-local-run.txt), [saved report](local_80f81c268c90464fa0279c6d028e4169.json), [native console](live-result-768.png). This is where the null-ID finding surfaced.
- All11 metric objects and all diagnostic notes from each saved report match their stored local_reports row exactly. The primary score is0.5375, chance0.0333, trivial baseline about0.2417, clean/noisy/short clips1.0 and pitch-shifted top-1 0.075. Timing remains a local measurement. Notes explain the ranking failures and pitch-shift weakness. Both reports declare no weights. This is actual local scoring and data preservation, not a synthetic report fixture. [Comparison](integration-proof.json).
- After both runs, Git status was clean. A README-only edit and local commit in the disposable course copy then returned to clean status, proving the SDK artifacts did not pollute ordinary Git work. The scored revision remains7125804; the later disposable documentation commit was not scored or pushed. [Git workflow](git-workflow.json).

The local portal's hosted provider was configured as fixture, so its global SIMULATED badge remains in screenshots. The two reports in this phase were produced by real local SDK execution, not fixture scoring. No hosted run button was used. The private team's Discord channel was null and the server had no Discord token; the live session has no Discord channel/message IDs.

## Private fixture and cleanup

Reused the baseline application database with an exact pre-pass backup, applied candidate migrations0042–0044 locally, and pointed only its existing private team at the real course repository name. The baseline's Audio catalog row was inactive, so that existing row was enabled for this Audio-only rehearsal, then restored. No Vision or Language source pin was changed, and no product patch was made.

All required CLI processes finished and the local server stopped. The exact application database was restored with complete SQL dump equality. Sessions, local reports and the new local session are gone; Audio's baseline active=0 is restored. Disposable project, venv, cache/config/credential directories, temporary Vite config/env and backup were removed. [Cleanup proof](cleanup.json). The frozen candidate has no tracked changes, only dependency symlinks. Retained student HEAD is still7125804 with clean status; retained environment source identities are unchanged. Browser viewport was reset, the audit tab closed, and Sam's original separate Helium window and extensions were untouched.

Local Audio setup, execution and sync are now established at these pins. The Verify here mismatch remains with the owners. Live GitHub push, real embedded Discord and production/hosted acceptance remain separate.
