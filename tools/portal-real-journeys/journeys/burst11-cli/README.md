# burst11-cli — the shipped CLI as a student seat

Installs and runs the shipped `cogworks` CLI the way a student would: three Python
seats (3.8 / 3.11 / 3.13) exercising `check`, `test`, and `run` on the Weeks 1–3
benchmark examples, each row twice — direct and behind a proxy that refuses S3 —
then walks the portal journey (dev sign-in → team → device link → status → sync →
report) in a real browser against the local fixture stack.

## What ran

### The three-seat matrix

Fixtures: `~/work/burst11-student/{week1-audio,week2-vision,week3-language}` —
fresh copies of the course examples with local git repos and synthetic `origin`
remotes (the CLI needs a GitHub origin to report `repositoryFullName`).

Seats: Python 3.8.20 and 3.11.10 with the full course dependency sets (Week 2's
`face_recognition_app` + `facenet_models` installed per the benchmark's own
requirements; CPU-only torch; gensim present for Week 3), and Python 3.13.0 with
only the CLI plus Week 1's dependencies.

Runner: `run-seat.sh <venv-dir> <tag>` — for every (week, benchmark) pair it runs
`check`, `test`, then `run` in direct mode and behind `s3-refusing-proxy.mjs`
(an HTTP/CONNECT proxy that 403s `s3.amazonaws.com` and forwards everything else,
so a run that claims "reported to hosted results" behind the proxy must be lying).
`NO_PROXY` exempts localhost so the portal/CLI traffic stays local.

Results (valid rows only; exit 0 = the designed success output):

| Seat  | Week 1 audio | Week 2 recognition | Week 2 clustering | Week 3 language | Row total |
| ----- | ------------ | ------------------ | ----------------- | --------------- | --------- |
| py38  | 6/6          | 6/6                | 6/6               | 6/6             | **24/24** |
| py311 | 6/6          | 6/6                | 6/6               | 6/6             | **24/24** |
| py313 | 6/6          | 0/6                | 0/6               | 0/6             | **6/24**  |

Every row is `check` + `test` + `run` in direct and proxy modes. py38 and py311
are fully green. The py313 rows that exit 2 are the benchmark packages' declared
`requires-python <3.13` refusing to install — `cogworks check` still runs and
gives the designed "not installed here" guidance instead of crashing, and Week 1
(check/test/run × direct/proxy) passes completely on 3.13.

The CLI's own post-run lines stay offline-correct: behind the refusing proxy every
row reports `LOCAL · <result>`, never hosted results.

### The portal journey (browser)

`link-and-approve.mjs` (Playwright, headless Chromium) against the fixture stack
(`tools/portal-real-journeys/stack`, profile `fixture`, Node 24): dev sign-in →
cohort → "Start a new team" on the fixture repository (`cogworks-demo/face-finder`)
→ `cogworks link` in a child process → device approval on `/connections` with the
code the CLI printed → `status`, `sync`, `report`, dashboard screenshots.
The run exits 0; `evidence/` holds the captured CLI outputs and dashboard shot.

Observed student-visible outputs (verbatim in `evidence/`):

- `cogworks link` exit 0: prints the verification URI + code, `Linked e2b.local.
  Local commands still work offline.`
- `cogworks status`: GitHub login, team (`Vector Voyagers`), repo, device
  (`burst11 seat (py3.11)`), expiry, portal URL.
- `cogworks sync`: `Synced local_… as LOCAL RUN · SELF-REPORTED.`
- `cogworks report`: the Week 1 identification metrics card.

## Findings

1. **`link`'s setup step handles origin mismatch instead of guessing.** The
   synthetic fixture's origin is `burst11-student/week1-audio` while the team repo
   is `cogworks-demo/face-finder`, so link reports `clone was not updated: This
   directory is burst11-student/week1-audio, but CogPortal expects
   cogworks-demo/face-finder` and still links the device (exit 0). Correct for a
   real seat, where the student clones the team repo.
2. **In dev-auth the join fast path covers only the fixture repo.** The team-join
   route grants `write` without a GitHub token only when `repoFullName` is
   `FIXTURE_REPO.fullName` (`apps/portal/worker/routes/team-membership.ts`);
   seeded cohort teams are unjoinable in the fixture harness by design, so the
   student-shaped path is creating a fresh team on the fixture repo.
3. **A stale `triton` pin can masquerade as "FaceNet is not installed".** In the
   3.11 seat, `facenet_models`' old `triton==2.2.0` pin broke torch 2.14's inductor
   import, so `from facenet_models import FacenetModel` raised ImportError and the
   CLI surfaced its designed contract message. Upgrading `triton` (not a code
   change) fixed the four clustering rows. The message is accurate about what to
   install; the root cause lives in the dependency set.
4. **Python 3.13 is a benchmark-metadata boundary, not a CLI defect.** The CLI
   installs and runs Week 1 on 3.13; Weeks 2–3 packages declare
   `requires-python <3.13` and the CLI's check output names the missing pieces.

## Running it

```
node s3-refusing-proxy.mjs &                      # the S3-refusing proxy
./run-seat.sh ~/work/b11-venvs/venv38 py38        # per seat; logs under ./logs
node link-and-approve.mjs                         # needs playwright + the fixture stack up
```

`run-seat.sh` expects student fixtures under `~/work/burst11-student` and writes
per-row logs to `~/work/b11-durable/logs` (override at the top of the script).
The browser leg expects the stack on `127.0.0.1:8850`.

## Not covered

- No real GitHub, S3, Discord, or GPU was touched: GitHub runs through the
  harness double, S3 through the refusing proxy, scoring runs locally.
- Weeks 2–3 on Python 3.13 are correctly refused by the packages themselves.
- The seeded-cohort join path in a real (token-backed) deployment.
