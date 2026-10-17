# PRESERVED REVIEW BRIEF — saved at workspace shutdown (2026-10-11): CI on head fd6d335 finished 16 success / 2 skipped / 0 failed; PR #105 stays draft, never merge.

# Benchmark data attribution — PR #105 review brief

**PR:** https://github.com/SamGu-NRX/CogPortal/pull/105 (draft, never merge)
**Branch:** `obv/products-l3-benchmark-data-attribution-20261010` → base `fix/device-link-recovery-20261004`
**Commits:** `421f45f` (tooling), `fd6d335` (generated evidence) — both authored by `Sam Gu <127461594+SamGu-NRX@users.noreply.github.com>` with the `obvious-autobuild[bot]` co-author trailer; author metadata verified before push; no rebase/amend/force-push.

## What to review

A rebuilt-from-scratch tool (the first copy died with a sandbox reset) that answers, from **committed repository metadata only**: what data, models, and mirrored material do the CogWorks benchmarks use, where is each pinned, what reuse notices exist? It records evidence; it does not grant permission.

- `tools/benchmark-data-attribution/inventory.py` — static extractor for pins, entry points, and committed notices (parent repo + checked-out submodule content). Refuses to guess: anything it cannot evaluate statically (cyclic/forward name references, dynamic values) is skipped, and missing reuse notices are recorded `unknown`.
- `schema/resources.schema.json` + `validate.py` — draft 2020-12 schema; dependency-free validator for exactly the keywords the schema uses; output is validated **before** writing (validate-before-write is itself tested).
- `reader.py` — offline reader (`summary` / `unknowns` / `resource <id>`) that refuses to display free text asserting permission (fail-closed guard); verbatim license quotes are observational and always shown.
- `docs/attribution/` — replayable evidence for tree `421f45f`: `resources.json` (13 resources: 7 verified, 1 secondary, 5 unknown), `summary.json`, `summary.md`, `url-checks.json`.

## Verification performed

- `python3 -m pytest tools/benchmark-data-attribution/test_inventory.py -q` → **30 passed** (synthetic-clone parser units, schema acceptance + 7 mutation rejections, reader-guard behavior, missing-input exit codes, validate-before-write enforcement, byte-identical determinism replay across two identical clones). Optional `jsonschema` cross-check runs when installed.
- Real-tree generation with `--verify-urls`: 3 submodule git remotes (`ls-remote`) + 9 HTTP checks, all reachable, recorded with the source revision.
- Push safety: `ci.yml` triggers on push/PR only (repo CI, `contents: read`); `publish-testpypi.yml` is `workflow_dispatch`-only and cannot fire from a branch push. No workflow files touched.
- Two passing milestones committed separately (tooling, then evidence) per the project's milestone rule.
- Repo CI on head `fd6d335` (verified via the GitHub API at ~07:30Z): all 18 check runs completed — **16 succeeded, 2 skipped** (the pre-existing Macroscope and Aikido checks), **0 failed** — covering the Python 3.8/3.11/3.13 matrix on ubuntu and windows plus the week1/week2/week3 and platform jobs.

## Bugs found and fixed during this rebuild

1. `static_assigns` only walked `ast.Assign`, missing the annotated `ARTIFACTS: Dict[...] = {...}` form — real week3 pins were silently absent until the guard fired.
2. `literal()` resolved concatenation but not `Name` nodes, so `_RELEASE + "x"` URLs failed to resolve — fixed with in-order name resolution (cycles and forward references still refused).
3. Reader CLI consumed a passed argv list as positional args — fixed to treat it as full argv.
4. Schema tightened (`sourceGroup` enum, `notes` required); synthetic fixture now mirrors the real declaration shapes.

## Known gaps (honest)

- The 5 `unknown` reuse states are real unknowns, not oversights: Week 1 and Week 3 submodules have no LICENSE at their pinned revisions; the FaceNet checkpoint and the three Week 3 artifacts have no committed reuse notice. Adding committed notices would flip them to `verified` on the next regeneration.
- No dataset or model artifacts were downloaded; reachability checks are read-only.
- My tests are not wired into the repo's CI config by me (per the project rule against editing workflows); the repo's own CI ran clean on the head commit, so its existing jobs are unaffected by the new files.
- Acceptance bar from the original request: generate an inventory from the repo, distinguish pinned/committed/bundled/mirrored sources, record verifiable provenance, use evidence-based state labels, check reachability read-only, and stay verifiable/repeatable — all met; nothing in the inventory asserts permission.
