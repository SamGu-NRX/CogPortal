# Journey 6 — Runner (apps/runner-modal), exercised locally

**Tested alpha SHA:** `33bb30fa1aa45c3279fc56c57e4b0f0e01c300d3` ("Merge #117: bring #116's skills and PR template onto alpha"). The briefing expected `c275083bd19f8b4e0996dd367f3d08a5870a62c9`; alpha has moved past it. All results in this report are at `33bb30fa`.
**Branch:** `obv/focus-cogportal-acceptance-alpha-20261011` · **Date:** 2026-10-12 · **Scope:** verification only — no app fixes; harness code only under `tools/audits/acceptance-alpha/`. Local execution only; no Modal account, no real student data, no discord.com, no paid providers.

## Environment
- Python 3.13.14 (system python in the acceptance sandbox; runner declares `requires-python >= 3.11`)
- venv `/home/user/work/acc-j6-venv` built from the runner's declared dependencies only: `modal>=1.4,<2`, `fastapi>=0.115,<1` (installed via `pip install -e apps/runner-modal`), plus `pytest` as the test runner the suite needs (pytest is not a declared dependency of the runner package itself).

## Part 1 — pytest suite
(pending)

## Part 2 — local parity tooling on real public week data
(pending)

## Part 3 — four submissions through the real local-mode controller/scorer
(pending)

## Part 4 — what this cannot cover
(pending)

## Gates — what Sam must provide
(pending)
