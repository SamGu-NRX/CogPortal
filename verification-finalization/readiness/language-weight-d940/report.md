# Local Language capture result

The one ordinary check passed, but the subsequent ordinary local run did not produce a valid weight receipt. Process 71159 was joined with exit code 0. The saved report is `local_3bac1865eacb4cbcb51df44d468d6a1b`, with empty `weightsUsed` and `weightsUploaded`, text MRR 0.7829385398961786, and no overall score. See `run.json` and `run.stderr`.

- Discovery reports two competing projections: `data/W_embed.npy` and its own retained copy under `.cogbench/weights/dc30a867393863098f9a19ef2c53d0c82b6dbd492b8710a331ad4f0ddda3ea6f/data/W_embed.npy`. Both are 409728 bytes with that exact SHA256. See `retained-model-verification.json`.
- The installed Week3 `language_search_benchmark/roles.py:105` skip list omits `.cogbench`; its directory walk at line 434 includes retained model files. `plugins.py:696` handles the resulting ambiguity by withholding the image-side binding. This explains why a successful initial check can leave a retained copy that breaks the next discovery.
- Exact source remains clean at 8789361ad7dec86fa724431873f674e03b449951. Installed SDK d9405278aac8268cd340e589f36dbad766d1e2a0 and Week3 fff786537567939936bf65042c09cdea27c90798 are recorded in `environment.json`.
- No second run, upload, sync, fork, association change or manual receipt was attempted. The working clone and isolated environment remain available for the owner-directed fix and subsequent verification.

The next step is for the SDK/Week3 owner to exclude SDK-retained artifacts from student weight discovery, then provide the exact successor for verification. Repository push access is a separate later issue recorded in `access.json`; credentials are not blocking this local phase.

## Successor 51363ba: scoring fixed, receipt still unavailable

Installed only Week3 51363ba42b17ef493357c5da266611ac45b5456c, preserving SDK d9405278aac8268cd340e589f36dbad766d1e2a0 and the original retained copy. `environment-51363ba.json` verifies the actual selected distribution metadata and imported module paths. One ordinary check and one ordinary run completed, sessions 83906 and 75701 both joined exit 0.

- Check selects original `data/W_embed.npy`; image, prepare and search bind with no ambiguity. Run report `local_72a4cafa009141cbb1c8ca14fc677168` scores overall 0.41257518789178643, retrieval MRR 0.22810871171646382 and search MRR 0.2266783120627169. The only diagnostic is the chance-baseline explanation.
- Transfer acceptance remains blocked: actual saved report has `weightsUsed: ["data/W_embed.npy"]` but `weightsUploaded: null`. Saved JSON matches stdout. This is not an upload receipt, and no cloud transfer was attempted.
- Original and retained files still match size 409728 and SHA256 dc30a867393863098f9a19ef2c53d0c82b6dbd492b8710a331ad4f0ddda3ea6f. Git is clean at upstream8789361. `retained-model-51363ba.json` records byte verification separately from unavailable scoring provenance.
- Confirmed mechanism: SDK resolve.py:608-613 clears captured receipts unless the Week3 consumption hook establishes them; cli.py:408 propagates this null to reporting. Week3 plugins.py:638-640 requires a direct named weight input on the image step. The selected image branch is `database.ImageDatabase.descriptor_to_embedding`, whose method reads constructor-held `self.W_embed`, database.py:6-14. Check supply evidence names W on the constructor, not the image method. This is the likely unsupported binding shape behind the null receipt; no runtime instrumentation or second run was used to prove a more specific hook branch.

Next prerequisite is owner-supported provenance for this constructor-held weight binding, or an owner-selected naturally supported real candidate, followed by an exact successor handoff. Once an honest local receipt passes, root must authorize the normal writable fork/staging repository association and correct staging package version before actual file transfer. Previous failed evidence remains unchanged. No source edits, fabricated receipts, model removal, extra evaluation, upload, fork, pairing or production Audio changes.

## Successor cc67edb: local scoring and retained receipt pass

Exact Week3 cc67edbc989df52e4273eced849603dc0ee802f5 was installed without dependency changes. SDK remains d9405278aac8268cd340e589f36dbad766d1e2a0. `environment-cc67edb.json` records selected package metadata, module paths and source identity. The ordinary check completed during interruption with successful JSON, empty stderr, all four branches bound, and non-null weightsCaptured. Its expired session handle did not preserve an exit code; no check process remained and no replacement check was run.

One subsequent ordinary local run, session 74277, was joined with exit code 0. Report `local_96d1fe338c8347428792ce982f0c4ce4` has overall 0.41257518789178643, retrieval MRR 0.22810871171646382 and search MRR 0.2266783120627169. All metrics equal the previous 51363ba scoring result. Only the chance-baseline diagnostic remains.

- Actual emitted and saved reports match. Both name `data/W_embed.npy` in weightsUsed and have a non-null weightsUploaded entry with that path, SHA256 dc30a867393863098f9a19ef2c53d0c82b6dbd492b8710a331ad4f0ddda3ea6f and size 409728. This field is local receipt evidence; no cloud upload occurred.
- Original and existing retained file independently match that digest and byte length. Student source is clean at 8789361ad7dec86fa724431873f674e03b449951. Prior failed and successful reports remain preserved. See `retained-model-cc67edb.json`, `run-cc67edb.json`, `check-cc67edb.json` and `resolved-cc67edb.json`.

Concrete staging handoff: use this exact preserved local report and model with SDK d940 plus Week3 cc67edb. Root must provide the exact staging successor carrying the accepted Week3 version, authorize the normal writable Language fork and staging repository association, and establish the separate Language staging CLI pairing before ordinary sync/file transfer. Existing upstream permission is pull-only as recorded in access.json. Do not repurpose production Audio account binding or config. The next acceptance requires actual private staging storage and hosted consumption evidence; this local result makes no such claim.
