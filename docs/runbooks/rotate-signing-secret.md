# Rotating RUNNER_SIGNING_SECRET

**Who this is for:** whoever has to change the shared signing secret, whether
because it leaked, because it is being set for the first time, or because a
year has passed. It assumes you have not read the signing code.

**What it costs:** nothing in money. It does cost a short outage, quantified in
section 3. Read that section before you start, because the outage is not
avoidable with the current design and the procedure below is arranged around
making it small and legible rather than around pretending it is zero.

---

## 1. What the secret is for

`RUNNER_SIGNING_SECRET` is one shared value that authenticates both directions
of the portal-to-Modal boundary: the Worker signs each job it sends to Modal
with it, and the Modal container signs every progress and result event it sends
back with the same value. Both sides recompute the signature and compare, so the
two systems must hold byte-identical copies or every request across that
boundary is refused.

There is no public key and no certificate here. It is a symmetric HMAC-SHA256
secret, which means holding it is the entire authorization to submit a job or to
report a result. Treat it as you would a database password.

Two facts that shape everything below:

- The system supports **exactly one active key at a time**. `RUNNER_SIGNING_KEY_ID`
  looks like it would let two keys coexist, but both verifiers compare it for
  equality against a single configured string and then discard it
  (`verifyRunnerEvent` in `apps/portal/worker/routes/runner-events.ts`,
  `submit_job` in `apps/runner-modal/src/cogworks_runner/modal_app.py`). There
  is no map from key id to secret anywhere. See section 7.
- A mismatch produces a bare 401 with no diagnostic text on the dispatch
  direction, and Modal logs nothing at all when it rejects. That is why the
  verification tools in section 5 exist and why you should run them rather than
  starting a real run to see whether it worked.

---

## 2. When you need this

- The value leaked, or you believe it may have.
- Someone with access to it left the project.
- You are setting it for the first time. Skip section 3 (nothing is running to
  break) and start at section 4.

As of 2026-08-24 both deployed environments are in that last case. An unsigned
POST to either callback route answers 501, which is the portal saying the secret
is not set:

```
$ curl -X POST https://cogportal-dev.sillion.app/api/internal/v1/runner/events \
    -H 'content-type: application/json' -d '{}'
{"error":{"code":"provider_unconfigured","message":"Runner signing is not configured."}}
```

`https://cogportal.sillion.app` answers identically. Both also run with
`EXECUTION_PROVIDER` set to `"fixture"` in `apps/portal/wrangler.jsonc`, in
both the top-level `vars` block and `env.production.vars`, so neither dispatches
anything today regardless.

---

## 3. This is a brief outage, and here is its exact shape

**It cannot be made atomic.** Cloudflare and Modal are separate systems with
separate credential stores, and there is no second key slot to stage a new value
in. Between the moment you change the first side and the moment you change the
second, the two sides hold different secrets and every signature check across
the boundary fails.

**What fails, precisely:**

| | If the mismatch is in this state | Result |
| --- | --- | --- |
| New run start | Worker signs with a secret Modal does not have | Modal's `submit_job` returns a bare 401. The Worker throws, marks the run `failed` with `failureCategory: "provider"`, and the student sees the `E-PROVIDER` card: "The isolated execution environment failed before your code ran. This is a platform problem, not a problem with your code." Retryable, and **no official attempt is consumed** (the `provider` entry in `packages/contracts/src/failures.ts`). Fails in seconds and costs nothing. |
| Run already executing | Container signs a callback with a secret the Worker does not have | The portal returns 401. `_post_event` does not retry on 401, so the event is simply lost (`_post_event` in `modal_app.py`). The sandbox finishes and is billed. The run sits in `queued` until the stale reaper fails it, which is `RUN_STALE_AFTER_SECONDS`, currently **3600 seconds** (`RUN_STALE_AFTER_SECONDS` in `wrangler.jsonc`, set in both environments). To the student this reads as a one-hour hang, then "The execution provider stopped reporting progress." The attempt is refunded. |

**How long.** The window is the wall-clock time between your two commands, plus
however long Modal takes to give you fresh containers. If you have both commands
typed and ready, that is a couple of minutes. Nothing about the design forces it
to be longer, and nothing lets it be zero.

**So drain first.** If you can stop new runs and let the running ones finish, the
window contains nothing that can be harmed. That is the whole reason section 4
starts where it does.

---

## 4. The procedure

### Step 0. Drain, if anything is running

Skip this if `EXECUTION_PROVIDER` is `"fixture"` everywhere, which is currently
true of both deployed environments (section 2). Nothing is in flight, so there
is nothing to drain.

Otherwise: set `EXECUTION_PROVIDER` to `"fixture"` in `apps/portal/wrangler.jsonc`
for the environment you are rotating and deploy it. New starts stop dispatching
immediately. Then wait for the runs already dispatched to reach a terminal
status. A run carries its provider on its own row (the `provider` column in
`worker/db/schema.ts`), so runs already sent to Modal keep behaving as Modal
runs and keep posting
callbacks; flipping the variable does not strand them.

If you cannot drain (an incident where the secret is known to be compromised is
the real case), rotate anyway and read section 6 for the ordering that costs the
least.

### Step 1. Generate the new value

```sh
openssl rand -hex 32
```

`openssl` ships with macOS, so there is nothing to install and no script in this
repository to run. If you prefer Python:

```sh
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

Both print 64 lowercase hex characters, which is 32 random bytes, which is 256
bits.

**Why that length and that alphabet.** 256 bits matches the SHA-256 digest size,
so a longer key buys nothing an attacker could use, and it is far past any
brute-force reach. Hex matters more than it looks: this value has to survive
being pasted into a `.dev.vars` line whose parser strips one pair of surrounding
quotes and understands no escapes
(`parse_env_file` in `apps/runner-modal/tools/preflight_dispatch.py`), a shell
`VAR=... command` prefix, and `modal secret create NAME KEY="value"`. Hex
contains no quote, backslash, dollar sign, space, or newline, so it cannot be
mangled anywhere in that chain. The code itself imposes no length or character
rule (`worker/env.ts` declares it as a plain optional string), so this is a
convention, not something a validator will catch if you ignore it.

The one hard requirement is that it not be empty. An empty value is treated as
absent on the Worker side (`worker/env.ts` sets `emptyStringAsUndefined`), and
below that WebCrypto refuses a zero-length HMAC key outright with
`DataError: Zero-length key is not supported`, while Python's `hmac` accepts one
happily. So an empty secret is not "unconfigured on both sides"; it is Modal
signing successfully and the Worker throwing.

Keep the value in your clipboard or a password manager for the next three steps.
Do not paste it into a file in this repository, a chat, a commit message, or
this runbook.

### Step 2. Modal, first

The Modal secret is named `cogworks-runner-signing`, which is the exact name
`modal_app.py` resolves at deploy time via `modal.Secret.from_name`. It holds
two keys, because Modal is where the key id lives for the runner side.

```sh
modal secret create cogworks-runner-signing \
  RUNNER_SIGNING_SECRET='<paste the new value>' \
  RUNNER_SIGNING_KEY_ID=runner-v1 \
  --force
```

`--force` overwrites the existing secret. Without it the command fails because
the secret already exists; there is no separate update subcommand in the Modal
CLI (verified against modal 1.5.4, the version pinned by
`apps/runner-modal/pyproject.toml`).

Then give the app fresh containers, because a container reads
`os.environ["RUNNER_SIGNING_SECRET"]` from an environment injected when it
started, so a container that is already warm keeps the old value:

```sh
.venv-deploy/bin/python apps/runner-modal/tools/deploy.py
```

Use that script rather than `modal deploy` for the reason its own docstring
gives: image definitions resolve client-side, so a container asked to resolve
`week1_image` would try to re-read local sources that only exist on a developer
machine. If you are certain no code changed and only want new containers,
`modal app rollover cogworks-runner --strategy recreate` does that instead.

Whether a warm container would eventually pick up a changed secret on its own
was not measured here, so this step forces the replacement rather than assuming
it. If you skip it, section 6 explains what you are relying on.

### Step 3. Cloudflare, per environment

Secrets do not copy between Wrangler environments; each named environment is a
separate Worker with its own store (the pre-deploy checklist comment in
`wrangler.jsonc` says this). So this is two commands, not one.

Staging (`cogportal-dev.sillion.app`, the default environment, no `--env` flag):

```sh
pnpm --filter @cogworks/portal exec wrangler secret put RUNNER_SIGNING_SECRET
```

Production (`cogportal.sillion.app`):

```sh
pnpm --filter @cogworks/portal exec wrangler secret put RUNNER_SIGNING_SECRET --env production
```

Each prompts for the value. Paste it at the prompt rather than piping it in, so
the secret never enters your shell history.

There is no deploy step after these. `wrangler secret put` creates and deploys a
new version of the Worker immediately, which is why it is the second half of the
rotation rather than something you batch with a later release.

If you are also changing `RUNNER_SIGNING_KEY_ID` (section 6 explains when that is
worth doing), it is an ordinary variable rather than a secret and lives in
`apps/portal/wrangler.jsonc`, once in the top-level `vars` block for staging and
once inside `env.production.vars`.
Editing it requires a deploy. It must match the value in the Modal secret from
step 2 exactly, because both sides compare it before they look at the signature.

### Step 4. Your own machine, only if you run against real Modal locally

`apps/portal/.dev.vars` is gitignored and holds the local copy:

```
RUNNER_SIGNING_SECRET="<the new value>"
```

You can skip the file entirely and supply it for a single command:

```sh
RUNNER_SIGNING_SECRET=... pnpm dev
```

If you are in fixture mode locally, which is the default, nothing local reads
this value and you can leave it empty.

---

## 5. Confirm it worked

Do not confirm by starting a real run. A real run answers "did it work" an hour
late in the failure case, after paying for a sandbox. These two tools answer it
in seconds and write nothing.

**Callback direction (Modal to portal).** This is the direction whose failure is
expensive, so check it first:

```sh
RUNNER_SIGNING_SECRET=... .venv-test/bin/python \
  apps/runner-modal/tools/probe_callback.py \
  --origin https://cogportal-dev.sillion.app
```

Repeat with `--origin https://cogportal.sillion.app` for production. The tool
posts one signed synthetic event whose run id cannot exist
(`run_probe_callback_does_not_exist`), so a pass writes nothing to the database.
Read its answers as:

| Output | Meaning |
| --- | --- |
| unsigned 401, signed 404 or 400 | **Pass.** The route is live and the deployed secret matches yours. The event is then refused for a reason that is not about authentication: 404 because its run does not exist, or 400 because the synthetic body is not a complete event. Either way the signature was accepted, which is the one thing this step establishes. |
| unsigned 501 | The secret is not set in that environment at all. Step 3 did not take, or you targeted the wrong environment. |
| signed 401 | The secret is set and differs from yours. This is the failure the tool exists to find. |
| unsigned 405 | The route is not deployed. Nothing else in the output can be interpreted. |

**Dispatch direction (portal to Modal).** This proves Modal holds the same value:

```sh
RUNNER_SIGNING_SECRET=... .venv-test/bin/python \
  apps/runner-modal/tools/verify_dispatch.py
```

It sends refusable requests plus one correctly signed job naming a SHA of forty
zeros, which is well-formed and does not exist, so an accepted job dies fetching
the archive in a few seconds rather than running an evaluation. Pass is five
401s, one 202, and the line "dispatch boundary verified". If the unauthenticated
refusals pass but the signed job returns 401, the secret or the key id differs
between the two sides.

Both tools take the secret from the process environment only. Neither prints it.

---

## 6. Recognizing a mismatch after the fact

If you did not run section 5 and something is wrong, this is how it presents.
The two directions look nothing alike, which is the most useful thing to know.

**Worker to Modal, a job being sent.** Modal's `submit_job` returns
`Response(status_code=401)` with no body and writes no log line
(both refusal branches in `submit_job`). The Worker throws
`Modal runner rejected job with status 401.` The student sees the run fail
within seconds with the `E-PROVIDER` card, which says the platform failed and
their code is not at fault, and no official attempt is consumed. Nothing in that
chain contains the word "signature", so a run failing this way looks like Modal
being down.

If the queue is bound rather than dispatching inline, the failure instead
appears in `wrangler tail` as
`{"event":"modal_dispatch_failed", ... "detail":"Modal runner rejected job with status 401."}`,
retried every 30 seconds up to five times, then dead-lettered, with the run
sitting in `queued` the whole time.

**Modal to Worker, an event coming back.** The portal returns 401 with a body
that does name the cause, either `"Runner signature is invalid."` or
`"Unknown runner signing key."` if the key id also moved. Nobody reads it:
`_post_event` treats 401 as non-retryable and re-raises without reading the
response (`_post_event` in `modal_app.py`), so the Modal function log shows an
`HTTPError: 401` traceback with no portal message in it. The run stays in the
phase it reached, usually `queued`, because even the first status event is
refused, and only the stale reaper resolves it an hour later. This is the case
that costs a full sandbox run before you learn anything.

**Two 401s that mean different things.** The key id is checked before the
signature, so a wrong key id and a wrong secret both return 401 to a caller
reading only status codes. The portal's message distinguishes them; Modal's
response does not distinguish anything, because it has no body.
`verify_dispatch.py` separates them by construction, which is what it is for.

**501 rather than 401** means the secret is absent, not wrong. That distinction
survives all the way to the tools and is worth keeping in mind: 501 is "nobody
set it", 401 is "two people set it differently".

---

## 7. If you cannot drain: which side to change first

Change **Modal first**, then Cloudflare.

The reasoning is the asymmetry in section 3. Whichever way you order it, new run
starts fail during the window, and they fail cheaply: seconds, no charge, no
attempt consumed, an honest error card, retryable. That cost is the same either
way. What differs is what happens to a job that is already executing.

A container that started before the rotation holds the old secret in its
environment. If Cloudflare moves first, that container's callbacks arrive at a
Worker holding the new secret and are refused, and the run strands for an hour
after a sandbox you have already paid for. If Modal moves first and you do not
force container replacement, that container still holds the old secret, the
Worker still holds the old secret, and its callbacks land normally. It finishes.

That is the tension with step 2's container replacement: forcing fresh
containers is what makes the new secret certainly active, and it is also what
kills the in-flight jobs the ordering was protecting. So the two cases are
genuinely different procedures:

- **Drained:** run step 2 exactly as written, replacement included. Nothing is
  in flight to lose, and you end certain that no container holds the old value.
- **Not drained, and you accept the risk:** update the Modal secret without the
  replacement, update Cloudflare, then replace containers once the in-flight
  runs are terminal. Between those, you are relying on warm containers keeping
  the old value, which was not measured here. If a container is recycled during
  that window its run strands.

**Bump the key id when the rotation is not routine.** Incrementing
`RUNNER_SIGNING_KEY_ID` from `runner-v1` to `runner-v2` buys no overlap, since
the key id selects nothing. What it buys is attribution: a straggler signed
under the old key is refused at the key id check with "Unknown runner signing
key" rather than at the signature check with "Runner signature is invalid",
which tells you the difference between "an old job is still landing" and "I
pasted the secret wrong". During an incident that distinction is worth the extra
deploy. For a scheduled rotation with a clean drain it is noise.

---

## 8. Future work: a key ring would remove the outage

The outage exists because each verifier holds one secret and compares the key id
against one string. A key ring would make `RUNNER_SIGNING_KEY_ID` mean something:
each side would hold a small map from key id to secret, sign with a designated
current key, and accept any key in the map. Rotation would then be three
independent, individually safe deploys (add the new key to both verifiers, move
both signers to it, remove the old key) with no window in which anything fails,
and it would let an in-flight job finish under the key it started with.

This is deliberately not built. `docs/runbooks/platform.md` records the choice:
the v1 boundary favors one active key over a key ring nobody has needed yet. It
is worth revisiting if rotations become routine, or before the first cohort
whose runs cannot be drained at a convenient hour, because the cost of the
current design is paid entirely by whoever is holding the pager rather than by
anyone reading the code.

---

## See also

- `docs/runbooks/gate-1-modal.md` sections 3 and 4, for what else has to be true
  before a dispatch works at all.
- `docs/runbooks/platform.md` section 6, for the surrounding incident response.
- `apps/portal/.dev.vars.example`, for what each runner variable does locally.
