# Gate 1: proving the Modal runner before students use it

**Who this is for:** whoever is taking the platform from fixture mode to one
real hosted run. It assumes you have the repository and a Modal account, and
nothing else.

**What it costs:** steps 1 to 5 are free. Steps 6 and 8 each spend one real
evaluation, roughly 75 to 900 seconds of sandbox time. Step 7 rebuilds images,
which costs build minutes the first time and is cached after that.

**What it does not do:** nothing here changes `apps/portal/wrangler.jsonc`.
That file holds the deployed staging and production settings, and switching
either one to Modal is a separate, deliberate decision. Everything below runs
against your own `.dev.vars`.

Gate 1 comes from `docs/mvp.md` line 39: run Modal M0 with a malicious contract
fixture and verify network denial, timeout, memory, archive, output, snapshot,
retry, and refund behaviour. Section 2 below goes through those eight one at a
time and says plainly which ones are already proven, which are partly proven,
and which need you to go and look.

---

## 0. Find out what is actually deployed

Measured 2026-08-24, and the reason this section is numbered zero rather than
appended at the end: the two deployed environments are further behind than
"a month stale."

```sh
python apps/runner-modal/tools/preflight_dispatch.py \
  --deployed https://cogportal-dev.sillion.app
```

Both `cogportal-dev.sillion.app` and `cogportal.sillion.app` reported one
blocker, and it is smaller and more specific than it first looked:

```
callback route   FAIL  the route is deployed and RUNNER_SIGNING_SECRET is not set there
```

**The callback route has no signing secret.** An unsigned POST to
`/api/internal/v1/runner/events` answers 501, which `verifyRunnerEvent`
returns before it looks at a signature when `RUNNER_SIGNING_SECRET` is
absent. The route is deployed and current; it simply cannot accept anything.
Dispatch into that and the sandbox runs to completion and posts every event
into a void, and the run sits in `queued` until the stale reaper resolves it
an hour later, which reads as a hang rather than as a configuration gap.

Mind the path. The handler registers on the `api` router and `index.ts`
mounts that at `/api`, so an event goes to `/api/internal/v1/runner/events`.
Probing without the prefix answers 405 from the single-page app catch-all,
which reads exactly like "the route is not deployed." That cost an hour here:
the wrong path reported 405 against a local dev server running the current
commit, which is what gave it away.

**The benchmark rows agree.** Both Week 2 benchmarks are at version 2 with
matching scorer, dataset, plugin, and contract versions in the deployed
database and in this checkout. An earlier version of this section said
otherwise, on the strength of three rows with `active = 0`. Those are
superseded benchmarks kept so old runs still resolve their own version, and
the local database holds the same three. Filtering on `active` is the
difference between "this environment is a month stale" and "this environment
is current," and I reported the first before checking.

Two active benchmarks are missing from the deployed database rather than
stale: `audio-identification` is absent, and `language-search` is present but
retired. Whichever benchmark you intend to run first has to be active there.

So the first honest statement about this platform is not "hosted execution
has never been switched on." It is that the portal, the Modal images, the
plugins, and the database rows are one contract living in four places, and
those four places have never been deployed from the same commit.

Do not sequence the fix. Deploying three of the four is not a smaller change,
it is an inconsistent one, and a dispatch against a partly-updated system
fails at `contract_check` with a cause you can already read from the two
checks above. Deploy the set together, then run the probes below, then flip
the provider as the only variable that changes at dispatch time.

---

## Before you start: what fixture mode was hiding

In fixture mode `dispatch()` in `apps/portal/worker/services/run-actions.ts`
returns immediately. Nothing is sent anywhere. Runs advance on a wall clock in
`worker/execution/sync.ts`, and their metrics come from
`fixtureMetrics()` in `worker/execution/fixture.ts`, which hashes the run id. That is a deliberate
design: it lets the whole portal be developed without an account or a bill.

It also means that when you switch to Modal, several things run for the first
time ever, together. The order below exists to make them run for the first time
one at a time, cheapest first.

---

## 1. The repository is complete

```sh
git submodule update --init --recursive
python3 scripts/validate_week2_submodule.py
```

**Proves:** the benchmark packages are actually present. They are submodules, so
a GitHub source archive does not contain them and a clone without
`--recurse-submodules` leaves them empty.

**Pass:** the validator exits 0 and prints nothing alarming.

**Fail:** "week2 submodule is missing" or an empty `benchmarks/week2`. Run the
submodule command again and read its output; a private submodule you lack access
to fails here rather than later.

---

## 2. The tests pass with your working tree

```sh
pnpm test
python3 scripts/run_python_tests.py
```

**Proves:** the code you are about to deploy behaves as its tests expect. Do
this before anything else that costs money.

Note `scripts/run_python_tests.py` refuses to start a suite whose imports are
missing rather than reporting import errors as passes. If it tells you numpy is
not importable, use an interpreter that has it. In this repository that is
`benchmarks/week2/.venv/bin/python`.

**Pass:** "Every suite passed."

**Fail:** read which suite. A failure in `apps/runner-modal/tests` is about the
code you are about to deploy and must be fixed first. A failure in the portal
tests may be unrelated to Modal, but find out rather than assuming.

**One thing to check by hand:** compare the deployed Modal app against your
working tree.

```sh
git diff --stat apps/runner-modal/src/cogworks_runner/modal_app.py
```

If that shows changes, the deployed endpoint is running older code than your
tests just exercised. Nothing you learn from a smoke test against the deployed
app tells you about your tree until you deploy (step 7).

---

## 3. The offline preflight

```sh
python apps/runner-modal/tools/preflight_dispatch.py
```

**Proves:** every dispatch precondition that can be checked without a network.
Most importantly, it computes an HMAC signature with the Worker's own
`hmacSignature` (extracted and run under node) and with the runner's own
`signature` (imported from `protocol.py`), over the same vectors, and compares
the bytes. Signing drift is the least legible failure in the whole path: both
sides answer a bare 401 with no diagnostics.

It also checks that required variables are set, that `PUBLIC_ORIGIN` is an https
origin Modal could actually reach, that `RUNNER_IMAGE_DIGEST` is a real digest
rather than the `unpublished` placeholder, that the job the Worker would build
survives both `validate_job` (what the endpoint runs) and `RunJobV1Schema` (what
the Worker parses), and that each active benchmark row in your local D1 agrees
with the plugin installed here on all five fields `_load_benchmark` compares.

To supply the signing secret for one command without writing it into a file:

```sh
RUNNER_SIGNING_SECRET=... python apps/runner-modal/tools/preflight_dispatch.py
```

The secret's value is never printed. It is reported as present or absent.

**Pass:** "READY" and exit 0.

**Fail:** each failing check prints the reason and the fix on the next line.
Three are worth knowing about in advance:

- *callback origin.* If `PUBLIC_ORIGIN` is `http://localhost:5173`,
  `assertModalConfigured` throws 501 and nothing is sent. See step 5.
- *benchmark versions.* A field disagreeing between the D1 row and the plugin
  means `_load_benchmark` will refuse the run at `contract_check` with a message
  that names no field. Run `pnpm db:migrate:local`. If they still disagree, the
  plugin in your checkout is ahead of the migrations and someone needs to write
  the migration that catches D1 up.
- *image digest.* Not blocking. See step 7.

**UNKNOWN is not a pass.** A check that could not run leaves the exit status
nonzero on purpose. If node is missing, the signing comparison did not happen,
and you would be dispatching over an unverified boundary.

---

## 4. The signing boundary against the deployed endpoint

```sh
RUNNER_SIGNING_SECRET=... python apps/runner-modal/tools/verify_dispatch.py
```

**Proves:** the secret you hold is the secret Modal holds, the key ids match,
and the endpoint refuses unsigned, wrongly signed, replayed, and tampered
requests. This is the single highest-value step: step 3 proved the two
constructions agree, and this proves the two *values* agree.

**Cost:** near zero. The accepted job names a SHA of forty zeros, which is
well-formed and does not exist, so the spawned job dies fetching the archive
after a few seconds in one small container. Do not pass `--spawn` unless you
mean to pay for a full evaluation.

**Pass:** five refusals report 401, the accepted job reports 202, and it prints
"dispatch boundary verified".

**Fail, and what each one means:**

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every check reports 0 with a network error | endpoint not deployed, or no network | `modal app list`; if `cogworks-runner` is not deployed, do step 7 first |
| The three unauthenticated refusals pass, the signed job returns 401 | the secret or the key id differs between the two sides | Read the value out of the `cogworks-runner-signing` Modal secret again. Check `RUNNER_SIGNING_KEY_ID` on both sides; it is compared first and independently |
| The signed job returns 400 | the endpoint parsed the body and rejected its shape | The endpoint is running a different protocol version than your tree. Deploy (step 7) |
| An unauthenticated request is *accepted* | signature verification is not running | Stop. Do not continue. This is a security failure, not a configuration problem |

Without the secret in the environment the tool runs the three unauthenticated
refusals only and exits 1, which still tells you the endpoint is live and does
not accept unsigned work.

---

## 5. Decide the callback problem

This is the step people skip and then lose an afternoon to.

`PUBLIC_ORIGIN` does two separate jobs. `origin()` in
`worker/execution/runner.ts` refuses anything that does not start with
`https://`, so a localhost origin never dispatches at all. And the origin
becomes `callback.url` in the job, which the Modal container posts every status,
completion, and failure event to, from Modal's network. An https origin that
only resolves on your machine dispatches successfully and then strands the run:
every `_post_event` call fails, the run sits in `queued` in D1, and only the
stale reaper resolves it, after an hour.

This section used to offer two options, a tunnel or fire-and-forget, and both
were answers to a question that has a better one. Staging is a real Cloudflare
Worker on a real https origin with a real D1, and Modal can already reach it.
It was written before that was true.

**Use staging.** It is the only choice that produces the thing worth having,
which is a permanent run id someone can open in a month, and it exercises the
exact code production will run: `origin()`, the D1 phase transitions, callback
ingestion, the run page, the refund path. Use a clearly labelled synthetic
team. `wrangler tail` gives you the live log a tunnel would have, and
`wrangler deploy` iterates in seconds.

**A tunnel is a debugging tool, not the first run.** Reach for it only if a
staging run fails in a way that needs stepping through Worker code. It is a
third environment that will not exist tomorrow, so evidence gathered there is
about nothing that persists, and it adds a component to exactly the run you
want fewest variables in.

**Fire and forget proves nothing new.** The sandboxes have already been smoke
tested directly. Watching them work again without the portal half is not
progress toward this gate.

Whichever you pick, know which one you picked. A stranded run is not a failed
run, and reading it as one sends you looking for a bug that is not there.

### Split the loop before you close it

The return half can be tested without Modal at all, and it is worth doing
first because it isolates a failure that otherwise only shows up as a 401 in
the middle of a full run.

The signing agreement check in `preflight_dispatch.py` proves the two
implementations compute the same signature over the same bytes. It says
nothing about whether the deployed secrets match, and a key that differs
between the Worker and the Modal secret fails exactly like a signing bug.
Post one hand-signed synthetic event to staging: that exercises the route,
the deployed secret, verification, and the database write, with no sandbox
involved. Only a call originating from Modal proves Modal's copy of the key.

---

## 6. Prove the sandboxes work, before deploying

```sh
python apps/runner-modal/tools/smoke_modal.py \
  --benchmark language-search \
  --repo <a real public repository>
```

**Proves:** prepare, the filesystem snapshot, restoring that snapshot into a
fresh sandbox, the network block, the pinned 3.8 venv, and scoring. It calls the
same `_prepare` and `_evaluate_*` functions the job runner calls, so a pass means
the real path works rather than a parallel copy of it.

**Cost:** one full evaluation.

**Choose week 3 (`language-search`) as your first target.** Its data is baked
into the image, so nothing needs to be provisioned. Week 1
(`audio-identification`) is seeded with `active = 0` in migration
`0020_week1_audio.sql` and cannot be started from the portal at all. Week 2 is
not supported by this tool: its payload needs a CelebA manifest the tool does not
build.

**Do not use the demo fixture repository.** `cogworks-demo/face-finder` is seeded
as `team_demo`'s repository and does not exist on GitHub. In fixture mode that
never mattered because nothing fetched it. In Modal mode its archive URL 404s and
every run fails at `repository_fetch`.

**Pass:** exit 0, with a snapshot id and a metrics block printed.

**Fail:** the tool prints the phase and the failure category the portal would
have recorded. Common ones:

- `repository_fetch` at prepare: the repository or SHA does not exist, or is
  private.
- `adapter_missing` at contract_check: the repository has no `submission.py` and
  no entry point, and discovery found nothing. That is a real answer about that
  repository, not a platform failure.
- `data_download` at contract_check: version disagreement. See step 3.
- `model_cache`: the image's baked checkpoint failed its checksum. The image
  needs rebuilding.

---

## 7. Deploy, and fix the image digest

```sh
rm -rf benchmarks/week1/build benchmarks/week2/build benchmarks/week3/build
python apps/runner-modal/tools/deploy.py
```

**Why this and not `modal deploy`:** `_prepare` creates its sandbox from inside a
Modal container, where the repository the image definitions read does not exist.
This script builds and publishes the images from the machine that does have the
repository, then deploys. `deploy.py` refuses to run if a stale `build/` tree
exists, because setuptools reuses it and silently ships month-old source; the
comment on `stale_build_trees` in `tools/deploy.py` records that this cost a deploy cycle to find.

**Cost:** image build minutes on the first run. `Image.build` returns the cache
when nothing changed.

**Pass:** three lines reading `published <name> -> im-...`, then `deployed`.

**Write down those `im-` ids.** They are the only real candidate for
`RUNNER_IMAGE_DIGEST`. Set it in your `.dev.vars` as `<name>@<id>`.

The digest selects nothing: `_sandbox_image` in `modal_app.py` picks an image by name. Its only use is one of three inputs to the `environmentDigest`
reported on a completed run. So the placeholder cannot fail a dispatch. What it
does is make every run's reproducibility record a hash of the word
"unpublished", so two runs on genuinely different images are recorded as
identical. Fix it before students see results.

After deploying, rerun step 6. Only now are you testing your working tree.

---

## 8. One real hosted run

Set the four values in `apps/portal/.dev.vars` (the commented block at the bottom
of `.dev.vars.example` explains each one and marks which is a secret), rerun the
preflight until it says READY, then:

```sh
pnpm dev
```

Connect a real repository, and start a **practice** run.

**Keep it practice, not official.** Two independent reasons. The
`cogworks-hidden-datasets` volume is empty, so an official run's dataset load
fails. And `promotePracticeRun` requires `parent.preparedArtifactId`, which only
a real Modal run sets, so no existing run can be promoted anyway.

**Pass:** the run page moves through preparing, installing, contract check,
evaluating, scoring, and ends with a degradation curve. The "simulated" chip is
gone, because `buildRunSurfaceSnapshot` in `worker/services/run-surfaces.ts`
sets it from the provider.

**Fail, by shape:**

| What you see | What happened | Where to look |
| --- | --- | --- |
| 501 `provider_unconfigured` immediately | `MODAL_RUNNER_URL`, `RUNNER_SIGNING_SECRET`, or an https `PUBLIC_ORIGIN` is missing | Step 3 |
| 502 "The run could not be queued" | the POST to Modal failed or was refused | Step 4 |
| The run sits in `queued` and never moves | dispatch succeeded, callbacks cannot reach you | Step 5. Confirm in Modal's logs that the job ran |
| `data_download` at contract_check | version disagreement | Step 3 |
| 409 `not_promotable` | the benchmark is `active = 0` | Week 1 is inactive by design |

---

# Section 2: the eight behaviours, one at a time

Gate 1 names eight. Here is what actually covers each, what does not, and what
you have to do yourself. Where something is already proven, the citation is the
work; do not redo it.

## Network denial

**Status: partly covered.**

Covered: evaluation sandboxes are created with `block_network=True` at
all four evaluate paths in `modal_app.py` (`_evaluate`, `_evaluate_v2`,
`_evaluate_week3`, `_evaluate_week1`). An isolated probe exists at
`src/cogworks_runner/m0_probe.py`, which creates a network-blocked sandbox and
asserts that a urlopen fails.

Not covered: the probe is a standalone `modal run` target, not wired into any
test, and nothing exercises the *prepare* sandbox's allowlist. Prepare runs with
`outbound_domain_allowlist` in `_prepare` naming four hosts. Nothing
verifies it reaches those four and nothing else.

**What to do:**

```sh
modal run apps/runner-modal/src/cogworks_runner/m0_probe.py
```

Pass: "M0 network isolation passed." Fail: it raises, and evaluation sandboxes
can reach the internet. That is a stop-everything failure, because hidden
datasets are only safe if a submission cannot exfiltrate them.

For the prepare allowlist there is no tool. Verify it by hand once: create a
sandbox with the same allowlist and confirm `api.github.com` resolves and some
other host does not. Record what you saw. Until someone does, the allowlist is
configuration nobody has watched work.

## Timeout

**Status: attribution covered, enforcement not.**

Covered: class `TimeoutAttribution` in `tests/test_failure_attribution.py`,
four tests. Elapsed time at the budget is a timeout; SIGKILL is a timeout even
slightly early; a fast crash is not a timeout; and a submission cannot claim one
by printing the word "killed". That last one matters because timeout and
`student_runtime` are both charged to the team, but the message differs and a
submission should not choose its own.

`tests/test_limit_attribution.py` adds the surrounding contract: all four
evaluate paths classify timeouts, they agree with each other, and they mark the
failure `infrastructure=False` so the attempt is spent.

Not covered: that Modal actually kills a sandbox at 900 seconds. No test can
show that without a live sandbox.

**What to do:** during the smoke run in step 6, note the wall clock. The comment
on `timeoutSeconds` in `runner.ts` records measured end-to-end times: 75s and 72s for one week 1
repository, 875s and 898s for another, and one run that reached 999s against the
900s budget. If your run lands near the budget, you have observed the enforcement
working. If you want to force it, run a submission with a deliberate long sleep
and confirm the portal reports a timeout rather than "Evaluation failed."

## Memory

**Status: not covered by any live test, and the classification has a known blind
spot.**

What exists: `tests/test_limit_attribution.py` pins the decision made about a
memory failure once it is reported. Every evaluate path classifies it, they
agree, and they charge it to the submission rather than refunding.

What that file also records, because it is worth knowing before you rely on it:
classification is by substring. each evaluate path's `except Exception` handler in `modal_app.py` decides
`memory_limit` by testing whether `str(error).lower()` contains "memory" or
"oom". Every exception class in `modal.exception` constructs with an **empty
message** (measured against modal 1.5.4, the version this repository pins), so a
Modal exception carrying no text matches neither substring and falls through to
`provider` with `infrastructure=True`, which refunds an official attempt that
should have been spent.

Why that is a blind spot rather than a live bug: the evaluate paths call
`process.wait()`, and per `ContainerProcess.wait` in `modal/container_process.py` that method catches
its own timeout internally and returns -1 instead of raising, so an ordinary
timeout reaches `_timed_out` rather than the exception handler. And `_timed_out`
recognizes it from elapsed time regardless of any message.

**What is genuinely unknown:** which exception Modal raises when a sandbox
exceeds its memory limit, and with what text. Nothing in this repository has
ever observed one. The tests do not guess.

**What to do:** this is the one gate item that needs you to go and look. Run one
submission that allocates past its ceiling (2048 MB for week 2, 4096 MB for weeks
1 and 3; see `memoryMb` in `buildRunJob`). Record the exact exception type and message the
controller saw. Then either confirm the substring matches, or open the fix with
that evidence in hand. Until then, treat a run reported as `provider` during
evaluation as possibly a misattributed OOM, and check the refund ledger.

## Archive

**Status: covered, as of this work.**

Covered: `tests/test_archive_safety.py` builds hostile archives, serves them
over loopback, and runs the real `PREPARE_SCRIPT` against each in a subprocess.
Eleven cases: symlink, hard link, device node, a path with `..`, a path that only
normalizes out of the root, an absolute path, two project roots, an oversize
`Content-Length` refused before the body is read, a response that streams past
the cap with no declared length, a control archive that succeeds, and a check
that every download refusal names "archive" so `_prepare` attributes it to
`repository_fetch` rather than to the team's packaging.

No Modal, no network, no cost. This is the "malicious contract fixture" Gate 1
asked for, for the archive half.

Not covered: that Modal's container isolation holds if a member did get through.
That is Modal's guarantee, not ours to test.

**What to do:** run it. It is part of the suite in step 2.

## Output

**Status: well covered.**

Covered: `tests/test_prediction_validation.py`, about 30 tests over count,
non-finite values (NaN, Inf, -Inf, float overflow, integers too wide to be
JSON-safe, at any nesting depth), top-level type, and element type. The file's
docstring explains why each one matters, and the reasons are concrete: a short
results list is not a crash, because `zip()` truncates, and four week 1 results
covering a submission's two correct queries score 1.0 where the honest twelve
score 0.2.

`tests/test_bounded_buffer.py`, five tests, pins that a chatty submission cannot
push the benchmark's own showcase lines out of the log. Written after a cloud
canary observed zero showcase lines while the same code produced ten locally.

`tools/probe_student_faults.py` and `tools/probe_week1_faults.py` run fifteen and
more ordinary student mistakes against the real benchmarks locally, asking
whether each returns a scored result with a readable diagnostic or takes the
scorer down. Free, and worth running after any change to an evaluation path.

**What to do:** nothing new. Run the probes when you touch scoring.

## Snapshot

**Status: not covered by any test.**

`_prepare` returns `sandbox.snapshot_filesystem().object_id` at
`_prepare` in `modal_app.py`, and each evaluate path restores it with
`modal.Image.from_id(snapshot_id)`. No test in `tests/` mentions snapshots, and
none can: it is a Modal API call whose behaviour is Modal's.

**What to do:** the smoke run in step 6 is the evidence. It calls `_prepare`,
takes the snapshot id, and restores it into a fresh network-blocked sandbox that
then runs the student code. It prints the snapshot id. A successful smoke run is
a successful snapshot round trip. Record the id you saw, so that a later failure
can be compared against a run that worked.

## Retry

**Status: one of three mechanisms covered, as of this work.**

Three things could duplicate work.

*Callback retry*, `_post_event` in `modal_app.py`. Covered by
`tests/test_callback_delivery.py`, fourteen tests driving the real `_post_event`
against a loopback server that misbehaves on purpose. It checks both halves:
that a transient 500 or 429 is retried rather than dropped (without which a
single Worker cold start loses a completed event permanently and the run is
reported as a provider failure an hour later), and that retrying is safe (every
attempt carries identical bytes and the same `eventId`, so the portal's
`onConflictDoNothing` collapses them into one). It also pins the subtle part:
each attempt is re-signed over its own timestamp, because reusing the first
signature would be refused by the replay check.

*Job dedupe*, in `execute_job` and `submit_job`, via the `cogworks-runner-jobs`
Modal Dict. Not covered. Needs a live Dict.

*Event dedupe*, in the POST handler of `routes/runner-events.ts`, a unique insert on `eventId` plus
the `event.sequence <= run.lastEventSequence` guard in `applyEvent`. Not covered
directly, though the callback tests pin the property it depends on.

*Queue retry*, `handleRunQueue` in `runner.ts`. Cannot run: the queue binding is commented out in
`wrangler.jsonc`, and `enqueueRun` posts directly when there is none.

**What to do:** after your first successful hosted run, replay one event by hand.
Take a completed event's exact body and headers from Modal's logs and POST it to
the callback URL a second time within the five-minute skew window. The portal
must answer `{"ok":true,"duplicate":true}` and the run's metrics must not change.
That is the check that matters, because it is the one that would double a score.

## Refund

**Status: well covered, and the best-tested item here.**

`worker/execution/refunds.ts` is the single decision point, and
`apps/portal/test/refund-cap.test.ts` drives it with seventeen tests against real
in-process SQLite built from the actual migration files, deliberately excluding
the seed and backfill migrations so the counts do not move when demo data
changes. It exercises the two paths reachable in a node test: the fixture state
machine and the stale reaper.

`REFUND_CAP = 5` is honestly documented in `refunds.ts` as having no measured
basis, because the platform never recorded a refund until the migration that
added `refunded_at`. The comment says so and says when to revisit.

**What to do:** nothing new before Gate 1. After real runs accumulate, look at
`refunded_at` and decide whether 5 is right.

---

# Where each item stands

| Behaviour | Covered by a test | Needs you to look |
| --- | --- | --- |
| Network denial | evaluation block, in source | run `m0_probe.py`; verify the prepare allowlist by hand once |
| Timeout | `test_failure_attribution.py`, `test_limit_attribution.py` | observe one real kill at the budget |
| Memory | classification only, and a blind spot is recorded | **record a real OOM's exception type and text** |
| Archive | `test_archive_safety.py`, 11 cases | nothing |
| Output | `test_prediction_validation.py`, `test_bounded_buffer.py` | nothing |
| Snapshot | nothing, and nothing can | the smoke run is the evidence |
| Retry | `test_callback_delivery.py` for callbacks | replay one event by hand |
| Refund | `refund-cap.test.ts`, 17 tests | nothing |

Three items still need a person: the prepare allowlist, a real memory failure,
and one hand-replayed event. None of them can be turned into a test without a
live sandbox, and pretending otherwise would give the gate a number it has not
earned.

---

# If something is already broken

**A run is stuck in `queued`.** Almost always the callback origin (step 5).
Confirm in Modal's logs whether the job ran. If it did, the sandboxes are fine
and the events cannot reach you.

**Everything returns 401.** The secret or the key id differs between the two
sides. `verify_dispatch.py` distinguishes them precisely; that is what it is for.
The construction itself is verified by the preflight, so a 401 in practice means
drift, not a bug.

**Every run fails at contract_check with a message naming nothing.** That is
`_load_benchmark` refusing on a version disagreement. The preflight names the
exact field.

**You need to stop.** Set `EXECUTION_PROVIDER` back to `fixture` in your
`.dev.vars`. Runs already dispatched keep behaving as Modal runs, because the
provider is written onto the run row rather than read from the environment. Let
the callbacks and the stale reaper settle. Do not delete rows by hand.

For deployed environments, the rollback procedure is in
`docs/runbooks/platform.md`, section 6.
