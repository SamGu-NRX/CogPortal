# Process-signals study: static summary

Regenerated from the recorded result bytes in `results/` only; no builder executes during replay.

- Manifest sha256: `5bf2720cac1ca1d376b7dde0a8fc1b8cac7ed2e728b18c1fd017974809236dc6`
- python/cogbench/src/cogbench/process.py: `b24d40c16d186486b67bc826db68094b8a6150b06aeef5affd172192bc0f18aa`
- apps/portal/worker/services/process-signals.ts: `1a99d96c379889ad4bad8c8ad4e1d473a08827fc6d0cfed497786e0eff84cd60`
- TypeScript arm: exercised via `pnpm exec tsx experiments/process-signals/run-worker.ts` (cwd `/home/user/work/CogPortal-signals`)

## Scenario rows (paired histories)

| Scenario | Declared | Python | TS | Verdict |
|---|---|---|---|---|
| week1-spread-usable | usable | usable | usable | agree |
| week1-single-commit | bulk_upload | bulk_upload | bulk_upload | agree |
| week1-empty | empty | empty | empty | agree |
| week1-share-bulk | bulk_upload | bulk_upload | bulk_upload | agree |
| week2-no-runs | usable | usable | usable | agree |
| week2-coauthors | usable | usable | usable | agree-except-documented-divergence |
| week3-boundary-timing | usable | usable | usable | agree |
| week1-fetch-failed-unauthorized | fetch_failed | None | fetch_failed | unexercisable-python (TS-only state; not evidence either way) |
| week1-exact-sixty | usable | usable | usable | agree |
| week1-unscored-only | usable | usable | usable | agree |

## Ablation rows

| Ablation | Python verdict | TS verdict |
|---|---|---|
| ablate-filename | confirmed | confirmed |
| ablate-scored-flag | confirmed | confirmed |
| ablate-coauthor | confirmed-null (zero delta was the expectation; still inconclusive about code paths this history never reaches) | confirmed |
| ablate-insertions | confirmed-null (zero delta was the expectation; still inconclusive about code paths this history never reaches) | confirmed-null (zero delta was the expectation; still inconclusive about code paths this history never reaches) |
| ablate-run-status | confirmed-null (zero delta was the expectation; still inconclusive about code paths this history never reaches) | confirmed-null (zero delta was the expectation; still inconclusive about code paths this history never reaches) |
| ablate-timestamp | confirmed | confirmed |
| combined-many-changes | confirmed | confirmed |

## Repeated-run determinism

- ablate-coauthor: python identical (pure function of frozen inputs); ts subprocess determinism covered by scenario repeats
- ablate-filename: python identical (pure function of frozen inputs); ts subprocess determinism covered by scenario repeats
- ablate-insertions: python identical (pure function of frozen inputs); ts subprocess determinism covered by scenario repeats
- ablate-run-status: python identical (pure function of frozen inputs); ts subprocess determinism covered by scenario repeats
- ablate-scored-flag: python identical (pure function of frozen inputs); ts subprocess determinism covered by scenario repeats
- ablate-timestamp: python identical (pure function of frozen inputs); ts subprocess determinism covered by scenario repeats
- combined-many-changes: python identical (pure function of frozen inputs); ts subprocess determinism covered by scenario repeats
- week1-empty: python identical; ts identical
- week1-exact-sixty: python identical; ts identical
- week1-fetch-failed-unauthorized: python unexercisable (process.py has no fetch-failure input); ts identical
- week1-share-bulk: python identical; ts identical
- week1-single-commit: python identical; ts identical
- week1-spread-usable: python identical; ts identical
- week1-unscored-only: python identical; ts identical
- week2-coauthors: python identical; ts identical
- week2-no-runs: python identical; ts identical
- week3-boundary-timing: python identical; ts identical

## What these results do not support

See `unsupported-interpretations.md` for the standing list. In short: an unexercised arm supports no claim; zero-delta ablations cannot rule out reading in unreached code paths; absence findings inside a truncated window are not attributable; and no per-person totals or grades exist anywhere in this study.
