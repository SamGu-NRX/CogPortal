"""Is this environment ready to send one real job to Modal? Answered offline.

`verify_dispatch.py` answers the same question by posting to the deployed
endpoint, which needs the network, a live deployment, and the real signing
secret. That is the stronger evidence and it should still be run. This runs
first, costs nothing, and catches the failures that do not need a network to
find: a variable that is absent, an origin Modal cannot call back, a placeholder
image digest, a job the endpoint would refuse on shape, and above all a signing
construction that differs between the two sides.

The signing check is the reason this file exists. Both sides compute
HMAC-SHA256 over `timestamp + "." + body`, but they are written in different
languages by different hands: `hmacSignature` in
apps/portal/worker/execution/runner.ts uses WebCrypto and a hand-rolled hex
encoder, `signature` in cogworks_runner/protocol.py uses hmac and hexdigest. A
mismatch there produces a bare 401 with no diagnostics on either side, which is
the least legible failure in the whole path. So this does not read the two
implementations and judge them similar. It runs both over fixed vectors and
compares the bytes.

    python apps/runner-modal/tools/preflight_dispatch.py

Reads apps/portal/.dev.vars by default. Process environment variables win over
the file, so one value can be supplied without editing anything:

    RUNNER_SIGNING_SECRET=... python apps/runner-modal/tools/preflight_dispatch.py

No secret value is ever printed. A secret is reported as present or absent.

Three outcomes per check. PASS means the check ran and the answer was good.
FAIL means the check ran and the answer was bad; the fix is on the next line.
UNKNOWN means the check could not run at all, which is never treated as a pass:
the exit status is nonzero and the summary says NOT READY. A plausible guess
about a boundary that has not been exercised is worse than saying we do not
know.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "apps" / "runner-modal" / "src"))

from cogworks_runner.protocol import (  # noqa: E402
    MAX_CLOCK_SKEW_SECONDS,
    ProtocolError,
    canonical_json,
    signature,
    validate_job,
    verify_signature,
)

RUNNER_TS = REPO_ROOT / "apps" / "portal" / "worker" / "execution" / "runner.ts"
MODAL_APP = REPO_ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py"
PROTOCOL_TS = REPO_ROOT / "packages" / "contracts" / "src" / "protocol.ts"
DEFAULT_ENV_FILE = REPO_ROOT / "apps" / "portal" / ".dev.vars"
WRANGLER = REPO_ROOT / "apps" / "portal" / "wrangler.jsonc"
D1_STATE = REPO_ROOT / "apps" / "portal" / ".wrangler" / "state" / "v3" / "d1" / "miniflare-D1DatabaseObject"

PASS = "PASS"
FAIL = "FAIL"
UNKNOWN = "UNKNOWN"

#: The five variables `assertModalConfigured` and `buildRunJob` read before a
#: single byte leaves the Worker. RUNNER_IMAGE_DIGEST is deliberately not here:
#: it has a default and cannot fail a dispatch, so it is checked separately for
#: what it actually costs (a meaningless reproducibility record).
REQUIRED_VARIABLES = (
    "EXECUTION_PROVIDER",
    "MODAL_RUNNER_URL",
    "RUNNER_SIGNING_SECRET",
    "RUNNER_SIGNING_KEY_ID",
    "PUBLIC_ORIGIN",
)

#: Names whose value must never reach stdout, a log, or a report.
SECRET_VARIABLES = frozenset({"RUNNER_SIGNING_SECRET"})

#: Vectors the two implementations are compared over. The plain one is the
#: common case. The JSON one carries the quotes and braces a real body has. The
#: last is non-ASCII, because the two sides pick their own encoding (a
#: TextEncoder on one side, `.encode("utf-8")` on the other) and a latin-1
#: slip would agree on every ASCII vector and diverge only on a student whose
#: repository name or error message is not ASCII.
SIGNING_VECTORS: Tuple[Tuple[str, str, str], ...] = (
    ("preflight-secret", "1700000000", "body"),
    ("preflight-secret", "1700000000", '{"runId":"run_01","sequence":0}'),
    ("clé-préflight", "1700000000", '{"detail":"café ünïcode, 日本語"}'),
)


def one_line(text: str, limit: int = 200) -> str:
    """Collapse whitespace and cap length.

    Reasons carry captured error text, and a node traceback is several lines
    with its own indentation. Printed as-is it breaks the aligned columns and
    buries the next check, which is the opposite of what a person scanning
    this needs.
    """

    collapsed = " ".join(str(text).split())
    return collapsed if len(collapsed) <= limit else collapsed[: limit - 3] + "..."


class Check:
    """One question, its answer, and what to do when the answer is bad."""

    def __init__(self, name: str, status: str, reason: str, fix: str = "") -> None:
        self.name = name
        self.status = status
        self.reason = one_line(reason)
        self.fix = one_line(fix, 400)

    def __repr__(self) -> str:  # pragma: no cover - diagnostic only
        return "Check({!r}, {!r})".format(self.name, self.status)


def ok(name: str, reason: str) -> Check:
    return Check(name, PASS, reason)


def bad(name: str, reason: str, fix: str) -> Check:
    return Check(name, FAIL, reason, fix)


def unknown(name: str, reason: str, fix: str) -> Check:
    return Check(name, UNKNOWN, reason, fix)


# --------------------------------------------------------------------------
# Reading the environment
# --------------------------------------------------------------------------


def parse_env_file(text: str) -> Dict[str, str]:
    """The subset of dotenv syntax `.dev.vars` actually uses.

    Wrangler's own parser is more permissive. Matching it exactly is not the
    job here: this reads the file a person edits by hand, and every line in
    the shipped `.dev.vars.example` is `NAME="value"` or `NAME=value`.
    """

    values: Dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, _, raw = stripped.partition("=")
        name = name.strip()
        if not name:
            continue
        raw = raw.strip()
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
            raw = raw[1:-1]
        values[name] = raw
    return values


def load_values(env_file: Optional[Path], environ: Dict[str, str]) -> Tuple[Dict[str, str], Optional[Path]]:
    """File first, then process environment on top.

    The override order is deliberate. The secret is the one value that should
    not be written to a file at all if it can be avoided, so supplying it for
    one command has to win over whatever the file says.
    """

    values: Dict[str, str] = {}
    found: Optional[Path] = None
    if env_file is not None and env_file.is_file():
        values.update(parse_env_file(env_file.read_text(encoding="utf-8")))
        found = env_file
    for name in REQUIRED_VARIABLES + ("RUNNER_IMAGE_DIGEST", "RUNNER_PYTHON_VERSION"):
        supplied = environ.get(name)
        if supplied:
            values[name] = supplied
    return values, found


# --------------------------------------------------------------------------
# Variable checks
# --------------------------------------------------------------------------


def check_required_variables(values: Dict[str, str]) -> List[Check]:
    checks: List[Check] = []
    for name in REQUIRED_VARIABLES:
        value = values.get(name, "").strip()
        if not value:
            checks.append(
                bad(
                    "variable {}".format(name),
                    "not set",
                    _fix_for(name),
                )
            )
            continue
        if name in SECRET_VARIABLES:
            checks.append(ok("variable {}".format(name), "present (value not shown)"))
        else:
            checks.append(ok("variable {}".format(name), value))
    return checks


def _fix_for(name: str) -> str:
    fixes = {
        "EXECUTION_PROVIDER": (
            'Set EXECUTION_PROVIDER="modal" in apps/portal/.dev.vars. Leave '
            "apps/portal/wrangler.jsonc alone; that is the deployed setting."
        ),
        "MODAL_RUNNER_URL": (
            "Set MODAL_RUNNER_URL to the deployed submit_job endpoint. "
            "`modal app list` names the app; the URL is printed by "
            "`modal deploy` and is also the default in tools/verify_dispatch.py."
        ),
        "RUNNER_SIGNING_SECRET": (
            "Read it from the Modal secret it was created with: "
            "`modal secret list` shows cogworks-runner-signing. Put it in "
            "apps/portal/.dev.vars, or pass it for one command. Never commit it."
        ),
        "RUNNER_SIGNING_KEY_ID": (
            'Set RUNNER_SIGNING_KEY_ID="runner-v1", and confirm the Modal '
            "secret carries the same key id. The two sides compare it before "
            "the signature, so a mismatch is a bare 401."
        ),
        "PUBLIC_ORIGIN": (
            "Set PUBLIC_ORIGIN to an https origin Modal can reach from the "
            "public internet. A localhost origin is refused before dispatch "
            "and would strand every callback even if it were not."
        ),
    }
    return fixes.get(name, "Set {}.".format(name))


def check_execution_provider(values: Dict[str, str]) -> Check:
    value = values.get("EXECUTION_PROVIDER", "").strip()
    if value == "modal":
        return ok("execution provider", "modal, so dispatch will really be sent")
    if value == "fixture":
        return bad(
            "execution provider",
            "fixture, so run-actions.ts dispatch() returns without sending anything",
            'Set EXECUTION_PROVIDER="modal" in apps/portal/.dev.vars.',
        )
    return bad(
        "execution provider",
        "{!r} is not one of fixture or modal".format(value),
        'Set EXECUTION_PROVIDER="modal" in apps/portal/.dev.vars.',
    )


def check_callback_origin(values: Dict[str, str]) -> Check:
    """The single most likely cause of a failed first dispatch.

    `origin()` in runner.ts throws 501 unless PUBLIC_ORIGIN starts with
    https://, so a localhost origin never reaches the network. And the origin
    is not only a gate: it becomes `callback.url`, which the Modal container
    posts every status, completion, and failure event to. An https origin that
    only resolves on this laptop dispatches fine and then strands the run in
    `queued` until the stale reaper clears it an hour later.
    """

    value = values.get("PUBLIC_ORIGIN", "").strip()
    if not value:
        return bad("callback origin", "PUBLIC_ORIGIN is not set", _fix_for("PUBLIC_ORIGIN"))
    if not value.startswith("https://"):
        return bad(
            "callback origin",
            "{} is not https, so assertModalConfigured throws 501 before any dispatch".format(value),
            "Expose the local portal on a public https origin (a tunnel is the "
            "usual way) and set PUBLIC_ORIGIN to it. docs/runbooks/gate-1-modal.md, "
            "'Decide the callback problem', gives the two options and what "
            "each one gives up.",
        )
    host = value[len("https://") :].split("/", 1)[0].split(":", 1)[0].lower()
    private = host in ("localhost", "127.0.0.1", "::1") or host.endswith(".local")
    if private:
        return bad(
            "callback origin",
            "{} is https but resolves only on this machine, so every callback would fail".format(value),
            "Use a public https origin. Modal posts run events to "
            "<origin>/api/internal/v1/runner/events from its own network.",
        )
    return ok("callback origin", "{}/api/internal/v1/runner/events".format(value.rstrip("/")))


def check_runner_url(values: Dict[str, str]) -> Check:
    value = values.get("MODAL_RUNNER_URL", "").strip()
    if not value:
        return bad("runner url", "MODAL_RUNNER_URL is not set", _fix_for("MODAL_RUNNER_URL"))
    if not value.startswith("https://"):
        return bad(
            "runner url",
            "{} is not https".format(value),
            "Modal web endpoints are https. Copy the URL `modal deploy` printed.",
        )
    return ok("runner url", value)


#: A published Modal image id, which is what `tools/deploy.py` prints as
#: `published <name> -> <object_id>`. Content-addressed digests written the
#: OCI way are also accepted, because a future registry-backed image would
#: carry one and refusing it would be wrong.
IMAGE_ID = re.compile(r"\bim-[A-Za-z0-9]{6,}\b")
OCI_DIGEST = re.compile(r"\bsha256:[a-f0-9]{64}\b")


def check_image_digest(values: Dict[str, str]) -> Check:
    """What the digest is for, and why the placeholder is not merely untidy.

    It selects nothing. `_sandbox_image` picks an image by name, not by digest.
    The digest's only consumer is the SHA-256 `environmentDigest` reported on
    the completed event, alongside the snapshot id and the plugin version. So a
    placeholder cannot fail a dispatch. What it does is make every run's
    reproducibility record a hash of the same constant word, which means two
    runs on genuinely different images are recorded as identical. That is a
    plausible wrong number, and it is worse than no number.
    """

    value = values.get("RUNNER_IMAGE_DIGEST", "").strip()
    fix = (
        "Run `python apps/runner-modal/tools/deploy.py` and copy the id it "
        "prints for the image this benchmark uses (`published "
        "cogworks-runner-week3 -> im-...`). Set RUNNER_IMAGE_DIGEST to "
        "`<name>@<id>` so the record names both."
    )
    if not value:
        return bad(
            "image digest",
            "not set, so runner.ts falls back to the constant "
            "'cogworks-week2-cpu-v1:unpublished'",
            fix,
        )
    if "unpublished" in value.lower():
        return bad(
            "image digest",
            "{} is the placeholder, so every environmentDigest is a hash of the same word".format(value),
            fix,
        )
    if IMAGE_ID.search(value) or OCI_DIGEST.search(value):
        return ok("image digest", value)
    return bad(
        "image digest",
        "{} is neither a Modal image id (im-...) nor an OCI digest (sha256:...)".format(value),
        fix,
    )


# --------------------------------------------------------------------------
# The signing boundary
# --------------------------------------------------------------------------


def extract_typescript_function(source: str, name: str) -> str:
    """One exported function's source text, by balanced braces.

    Taken from the shipped file rather than copied here on purpose. A preflight
    built on a paraphrase of the Worker's signer would agree with itself
    forever and prove nothing about the Worker.
    """

    marker = "export async function {}".format(name)
    start = source.find(marker)
    if start < 0:
        marker = "export function {}".format(name)
        start = source.find(marker)
    if start < 0:
        raise LookupError("{} is not exported from the source given".format(name))
    depth = 0
    index = source.index("{", start)
    while index < len(source):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start : index + 1]
        index += 1
    raise LookupError("{} has unbalanced braces".format(name))


def node_signer(node: str, workdir: Path) -> Callable[[Sequence[Tuple[str, str, str]]], List[str]]:
    """Run the Worker's own `hmacSignature` over a batch of vectors.

    Node runs TypeScript directly by stripping types, so the function's real
    text goes into a `.mts` file and is called. One process for the whole
    batch: startup dominates, and a per-vector process would make this the
    slowest check for no gain.
    """

    body = extract_typescript_function(RUNNER_TS.read_text(encoding="utf-8"), "hmacSignature")

    def sign(vectors: Sequence[Tuple[str, str, str]]) -> List[str]:
        script = workdir / "hmac_probe.mts"
        payload = json.dumps([list(vector) for vector in vectors])
        script.write_text(
            body
            + "\nconst vectors = "
            + payload
            + ";\nconst out = [];\n"
            + "for (const [secret, timestamp, message] of vectors) "
            + "out.push(await hmacSignature(secret, timestamp, message));\n"
            + "console.log(JSON.stringify(out));\n",
            encoding="utf-8",
        )
        finished = subprocess.run(
            [node, str(script)], capture_output=True, text=True, timeout=120
        )
        if finished.returncode != 0:
            raise RuntimeError(finished.stderr.strip()[:400] or "node exited nonzero")
        return json.loads(finished.stdout.strip())

    return sign


def python_signer(vectors: Sequence[Tuple[str, str, str]]) -> List[str]:
    return [
        signature(secret, timestamp, message.encode("utf-8"))
        for secret, timestamp, message in vectors
    ]


def compare_signatures(
    worker_signer: Callable[[Sequence[Tuple[str, str, str]]], List[str]],
    runner_signer: Callable[[Sequence[Tuple[str, str, str]]], List[str]],
    vectors: Sequence[Tuple[str, str, str]] = SIGNING_VECTORS,
) -> Check:
    """Do the two implementations produce the same bytes? Computed, not read.

    Split out from the node plumbing so a test can drive it with two callables
    and no subprocess, including a deliberately wrong one.
    """

    try:
        left = worker_signer(vectors)
    except Exception as error:  # noqa: BLE001 - the reason is the whole point
        return unknown(
            "signing agreement",
            "the Worker signer could not be run: {}".format(str(error)[:200]),
            "This check needs node on PATH and an intact "
            "apps/portal/worker/execution/runner.ts. Until it runs, treat the "
            "signing boundary as unproven and run tools/verify_dispatch.py "
            "against the deployed endpoint before dispatching.",
        )
    try:
        right = runner_signer(vectors)
    except Exception as error:  # noqa: BLE001
        return unknown(
            "signing agreement",
            "the Modal signer could not be run: {}".format(str(error)[:200]),
            "protocol.py is stdlib only; an error here means the import is broken.",
        )
    if len(left) != len(vectors) or len(right) != len(vectors):
        return bad(
            "signing agreement",
            "a signer returned {} and {} results for {} vectors".format(
                len(left), len(right), len(vectors)
            ),
            "Both signers must return one hex signature per vector.",
        )
    for index, (produced, expected) in enumerate(zip(left, right)):
        if produced != expected:
            _secret, timestamp, message = vectors[index]
            return bad(
                "signing agreement",
                "vector {} disagrees: timestamp {}, {} byte body, "
                "worker {}..., runner {}...".format(
                    index, timestamp, len(message.encode("utf-8")),
                    produced[:12], expected[:12],
                ),
                "The two sides must both compute "
                "HMAC-SHA256(secret, utf8(timestamp + '.' + body)) and "
                "lowercase hex it. Compare hmacSignature in "
                "apps/portal/worker/execution/runner.ts against signature in "
                "apps/runner-modal/src/cogworks_runner/protocol.py. Do not "
                "dispatch until they agree: a mismatch is a bare 401 with no "
                "diagnostics on either side.",
            )
    return ok(
        "signing agreement",
        "{} vectors, including non-ASCII, produce identical signatures".format(len(vectors)),
    )


def check_verify_accepts_and_refuses(
    worker_signer: Callable[[Sequence[Tuple[str, str, str]]], List[str]],
) -> Check:
    """Modal's verifier must accept the Worker's signature and refuse the rest.

    Agreement on the raw HMAC is necessary and not sufficient. `verify_signature`
    also requires the `v1=` prefix the Worker sends and enforces a clock-skew
    window, and either of those could drift independently of the hash.
    """

    secret, timestamp, message = "preflight-secret", "1700000000", '{"sequence":0}'
    body = message.encode("utf-8")
    now = int(timestamp)
    try:
        produced = worker_signer([(secret, timestamp, message)])[0]
    except Exception as error:  # noqa: BLE001
        return unknown(
            "signature verification",
            "the Worker signer could not be run: {}".format(str(error)[:200]),
            "Same requirement as the signing agreement check: node on PATH.",
        )

    cases = [
        ("the Worker's own signature is accepted",
         verify_signature(secret, timestamp, body, "v1=" + produced, now_seconds=now), True),
        ("a bare signature without the v1= prefix is refused",
         verify_signature(secret, timestamp, body, produced, now_seconds=now), False),
        ("a signature over a different body is refused",
         verify_signature(secret, timestamp, b'{"sequence":1}', "v1=" + produced, now_seconds=now), False),
        ("a timestamp at the skew limit is accepted",
         verify_signature(secret, timestamp, body, "v1=" + produced,
                          now_seconds=now + MAX_CLOCK_SKEW_SECONDS), True),
        ("a timestamp one second past the limit is refused",
         verify_signature(secret, timestamp, body, "v1=" + produced,
                          now_seconds=now + MAX_CLOCK_SKEW_SECONDS + 1), False),
    ]
    wrong = [label for label, actual, expected in cases if actual is not expected]
    if wrong:
        return bad(
            "signature verification",
            "; ".join(wrong),
            "verify_signature in "
            "apps/runner-modal/src/cogworks_runner/protocol.py disagrees with "
            "what runner.ts sends. Fix that before dispatching.",
        )
    return ok(
        "signature verification",
        "prefix, body binding, and the {}s skew window all behave".format(MAX_CLOCK_SKEW_SECONDS),
    )


def check_callback_direction(
    worker_signer: Callable[[Sequence[Tuple[str, str, str]]], List[str]],
) -> Check:
    """The reverse direction, which uses the same HMAC over different bytes.

    Modal signs `canonical_json(event)`: sorted keys, no spaces. The Worker
    verifies the raw request text it received, before parsing, so key order
    never has to be reproduced. What must hold is that the Worker's signer,
    run over exactly those bytes, reproduces what Modal computed.
    """

    event = {
        "type": "status",
        "runId": "run_preflight",
        "sequence": 0,
        "occurredAt": 1_700_000_000_000,
        "protocolVersion": "1",
        "eventId": "event_preflight_0",
        "status": "preparing",
    }
    body = canonical_json(event)
    timestamp = "1700000000"
    secret = "preflight-secret"
    modal_side = signature(secret, timestamp, body)
    try:
        worker_side = worker_signer([(secret, timestamp, body.decode("utf-8"))])[0]
    except Exception as error:  # noqa: BLE001
        return unknown(
            "callback signing",
            "the Worker signer could not be run: {}".format(str(error)[:200]),
            "Same requirement as the signing agreement check: node on PATH.",
        )
    if worker_side != modal_side:
        return bad(
            "callback signing",
            "the Worker would compute {}... over the canonical event bytes, "
            "Modal computes {}...".format(worker_side[:12], modal_side[:12]),
            "routes/runner-events.ts verifies the raw request text with the "
            "same hmacSignature. If these disagree, every callback is a 401 "
            "and every run strands until the stale reaper clears it.",
        )
    return ok("callback signing", "canonical event bytes sign identically in both directions")


# --------------------------------------------------------------------------
# The job the endpoint would receive
# --------------------------------------------------------------------------


def sandbox_floors(source: str) -> Dict[str, float]:
    """The lower bounds `modal.Sandbox.create` is called with, read from source.

    Neither schema knows about these. The Worker's zod schema bounds memoryMb
    at 128 and cpu above 0, but modal_app passes `memory=(512, memoryMb)` and
    `cpu=(0.5, cpu)`, and a maximum below its own minimum is not a sandbox
    Modal will create. Reading the literals instead of restating them means a
    future change to the floors shows up here rather than in a failed run.
    """

    floors: Dict[str, float] = {}
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        target = node.func
        if not (isinstance(target, ast.Attribute) and target.attr == "create"):
            continue
        for keyword in node.keywords:
            if keyword.arg not in ("cpu", "memory"):
                continue
            if not isinstance(keyword.value, ast.Tuple) or not keyword.value.elts:
                continue
            first = keyword.value.elts[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, (int, float)):
                floors[keyword.arg] = max(floors.get(keyword.arg, 0), float(first.value))
    return floors


def check_runtime_floors(job: Dict[str, Any], floors: Dict[str, float]) -> Check:
    if not floors:
        return unknown(
            "sandbox floors",
            "no Sandbox.create(cpu=..., memory=...) literals were found in modal_app.py",
            "Check that apps/runner-modal/src/cogworks_runner/modal_app.py is intact.",
        )
    runtime = job["runtime"]
    problems = []
    if "cpu" in floors and runtime["cpu"] < floors["cpu"]:
        problems.append(
            "cpu {} is below the sandbox floor {}".format(runtime["cpu"], floors["cpu"])
        )
    if "memory" in floors and runtime["memoryMb"] < floors["memory"]:
        problems.append(
            "memoryMb {} is below the sandbox floor {}".format(
                runtime["memoryMb"], floors["memory"]
            )
        )
    if problems:
        return bad(
            "sandbox floors",
            "; ".join(problems),
            "modal.Sandbox.create receives (floor, requested). A requested "
            "value below the floor is not a sandbox Modal will create. Raise "
            "the value in buildRunJob or lower the floor in modal_app.py.",
        )
    return ok(
        "sandbox floors",
        "cpu {} and memoryMb {} clear the floors ({} and {})".format(
            runtime["cpu"], runtime["memoryMb"],
            floors.get("cpu", "none"), floors.get("memory", "none"),
        ),
    )


def build_run_job(node: str, workdir: Path, values: Dict[str, str], benchmark: Dict[str, Any],
                  mode: str = "practice") -> Dict[str, Any]:
    """Run the Worker's real `buildRunJob` and return the job it produces.

    runner.ts imports a database client, drizzle, and the error type, none of
    which exist outside a Worker. Only the import specifiers are rewritten, to
    a stub module that supplies those names; every line of buildRunJob itself
    is the shipped line. Restating its defaults here would make this check
    agree with the restatement rather than with the Worker.
    """

    source = RUNNER_TS.read_text(encoding="utf-8")
    stub = workdir / "worker_stub.mts"
    stub.write_text(
        "export const eq = () => null;\n"
        "export const sql = () => null;\n"
        'export const getDb = () => { throw new Error("no database in preflight"); };\n'
        'export const runs = { id: "id", dispatchAttempts: "dispatch_attempts" };\n'
        "export class ApiHttpError extends Error {\n"
        "  status; code;\n"
        "  constructor(status, code, message) { super(message); this.status = status; this.code = code; }\n"
        "}\n"
        "let counter = 0;\n"
        'export const newId = (prefix) => prefix + String(++counter);\n'
        "export type Env = Record<string, string | undefined>;\n"
        "export type RunRow = any; export type TeamRow = any; export type BenchmarkRow = any;\n",
        encoding="utf-8",
    )
    replacements = {
        '"drizzle-orm"': '"./worker_stub.mts"',
        '"../db/client"': '"./worker_stub.mts"',
        '"../db/schema"': '"./worker_stub.mts"',
        '"../http/errors"': '"./worker_stub.mts"',
        '"../util/id"': '"./worker_stub.mts"',
        '"../env"': '"./worker_stub.mts"',
        '"@cogworks/contracts/protocol"': '"{}"'.format(PROTOCOL_TS),
    }
    for original, replacement in replacements.items():
        source = source.replace("from " + original, "from " + replacement)
    (workdir / "worker_runner.mts").write_text(source, encoding="utf-8")

    env_for_node = {
        "PUBLIC_ORIGIN": values.get("PUBLIC_ORIGIN", ""),
        "RUNNER_SIGNING_KEY_ID": values.get("RUNNER_SIGNING_KEY_ID", ""),
        "MODAL_RUNNER_URL": values.get("MODAL_RUNNER_URL", ""),
        # Never sent to node. assertModalConfigured only checks it is truthy,
        # so a placeholder proves the same thing without the value leaving here.
        "RUNNER_SIGNING_SECRET": "present" if values.get("RUNNER_SIGNING_SECRET") else "",
        "RUNNER_IMAGE_DIGEST": values.get("RUNNER_IMAGE_DIGEST", ""),
        "RUNNER_PYTHON_VERSION": values.get("RUNNER_PYTHON_VERSION", ""),
    }
    env_for_node = {name: value for name, value in env_for_node.items() if value}
    driver = workdir / "build_job.mts"
    driver.write_text(
        'import { buildRunJob } from "./worker_runner.mts";\n'
        "const env = " + json.dumps(env_for_node) + ";\n"
        "const run = " + json.dumps({
            "id": "run_preflight",
            "mode": mode,
            "preparedArtifactId": None,
            "sha": "a" * 40,
        }) + ";\n"
        "const team = " + json.dumps({
            "repoOwner": "cogworks-preflight",
            "repoName": "example",
            "repoId": 1,
            "repoFullName": "cogworks-preflight/example",
        }) + ";\n"
        "const benchmark = " + json.dumps(benchmark) + ";\n"
        "console.log(JSON.stringify(buildRunJob(env, run, team, benchmark)));\n",
        encoding="utf-8",
    )
    finished = subprocess.run([node, str(driver)], capture_output=True, text=True, timeout=120)
    if finished.returncode != 0:
        raise RuntimeError(finished.stderr.strip()[:400] or "node exited nonzero")
    return json.loads(finished.stdout.strip())


def check_job_is_acceptable(label: str, job: Dict[str, Any]) -> List[Check]:
    """Would the deployed endpoint take this job? Two separate answers.

    `validate_job` is what submit_job runs, and it checks structure: the exact
    field set, the protocol version, the SHA length, the archive host, the
    https callback. It does not look at the runtime numbers at all. The zod
    schema in packages/contracts is what bounds those. Both run here because
    each refuses things the other allows, and a job has to survive both.
    """

    checks: List[Check] = []
    try:
        validate_job(job)
        checks.append(ok("job accepted by Modal ({})".format(label), "validate_job passed"))
    except ProtocolError as error:
        checks.append(
            bad(
                "job accepted by Modal ({})".format(label),
                str(error),
                "submit_job runs this exact check and answers 400. Fix "
                "buildRunJob in apps/portal/worker/execution/runner.ts, or the "
                "benchmark row the job was built from.",
            )
        )
    return checks


def check_job_bounds(node: str, workdir: Path, label: str, job: Dict[str, Any]) -> Check:
    driver = workdir / "bounds.mts"
    driver.write_text(
        'import { RunJobV1Schema } from "' + str(PROTOCOL_TS) + '";\n'
        + "const parsed = RunJobV1Schema.safeParse(" + json.dumps(job) + ");\n"
        + "console.log(JSON.stringify(parsed.success ? { ok: true } : "
        + "{ ok: false, issues: parsed.error.issues.map(i => i.path.join('.') + ': ' + i.message) }));\n",
        encoding="utf-8",
    )
    try:
        finished = subprocess.run([node, str(driver)], capture_output=True, text=True, timeout=120)
        if finished.returncode != 0:
            raise RuntimeError(finished.stderr.strip()[:300] or "node exited nonzero")
        result = json.loads(finished.stdout.strip())
    except Exception as error:  # noqa: BLE001
        return unknown(
            "runtime limits ({})".format(label),
            "the contract schema could not be run: {}".format(str(error)[:200]),
            "This check needs node on PATH and packages/contracts intact.",
        )
    if not result.get("ok"):
        return bad(
            "runtime limits ({})".format(label),
            "; ".join(result.get("issues", [])[:4]),
            "RunJobV1Schema in packages/contracts/src/protocol.ts is what the "
            "Worker parses its own job through, so this job would be refused "
            "before it was ever sent.",
        )
    runtime = job["runtime"]
    return ok(
        "runtime limits ({})".format(label),
        "python {}, cpu {}, {} MB, {} s, {} B log".format(
            runtime["pythonVersion"], runtime["cpu"], runtime["memoryMb"],
            runtime["timeoutSeconds"], runtime["maxOutputBytes"],
        ),
    )


# --------------------------------------------------------------------------
# Benchmark rows against installed plugins
# --------------------------------------------------------------------------


def local_d1_path() -> Optional[Path]:
    if not D1_STATE.is_dir():
        return None
    candidates = [
        path
        for path in sorted(D1_STATE.glob("*.sqlite"))
        if path.name != "metadata.sqlite"
    ]
    return candidates[0] if candidates else None


def read_active_benchmarks(database: Path) -> List[Dict[str, Any]]:
    connection = sqlite3.connect("file:{}?mode=ro".format(database), uri=True)
    try:
        rows = connection.execute(
            "SELECT id, version, contract_version, plugin_version, dataset_version, "
            "scorer_version FROM benchmarks WHERE active = 1 ORDER BY id"
        ).fetchall()
    finally:
        connection.close()
    return [
        {
            "id": row[0],
            "version": row[1],
            "contractVersion": row[2],
            "pluginVersion": row[3],
            "datasetVersion": row[4],
            "scorerVersion": row[5],
        }
        for row in rows
    ]


#: Where each benchmark plugin lives in this repository. They are submodules,
#: not PyPI packages, so an import needs the directory on the path.
PLUGIN_PATHS = (
    REPO_ROOT / "python" / "cogbench" / "src",
    REPO_ROOT / "benchmarks" / "week1",
    REPO_ROOT / "benchmarks" / "week2",
    REPO_ROOT / "benchmarks" / "week3",
)

#: The five fields `_load_benchmark` compares, and the plugin attribute each
#: one is read from. `dataset_version` is deliberately absent: the controller
#: does not compare it, so a practice run sending "practice-v1" is correct.
VERSION_FIELDS = (
    ("id", "benchmark_id"),
    ("version", "benchmark_version"),
    ("contractVersion", "contract_version"),
    ("pluginVersion", "plugin_version"),
    ("scorerVersion", "scorer_version"),
)


def check_benchmark_versions(benchmarks: Sequence[Dict[str, Any]]) -> List[Check]:
    """`_load_benchmark` refuses on any disagreement, and says nothing useful.

    It compares five fields between the job (built from the D1 row) and the
    plugin baked into the image, then raises `data_download` at
    `contract_check` with infrastructure=true and the message "Trusted
    benchmark plugin version does not match the run job." That message names
    no field, so a mismatch found in a hosted run costs a paid evaluation and
    still leaves you guessing. Two migrations moved these values recently
    (0025 for week 3's scorer, 0026 for week 2's clustering), so a database
    that is behind sends the old string.

    The plugin read here is the one in this checkout. The one that matters is
    the one baked into the deployed image, which is the same source only if
    the image was built after the last change to it.
    """

    for path in PLUGIN_PATHS:
        if path.is_dir() and str(path) not in sys.path:
            sys.path.insert(0, str(path))
    try:
        from cogbench.plugins import load_benchmark
    except Exception as error:  # noqa: BLE001
        return [
            unknown(
                "benchmark versions",
                "cogbench could not be imported: {}".format(str(error)[:160]),
                "Run `git submodule update --init --recursive`, then use an "
                "interpreter with numpy (the week 2 venv has one).",
            )
        ]

    checks: List[Check] = []
    for row in benchmarks:
        try:
            plugin = load_benchmark(row["id"])
        except Exception as error:  # noqa: BLE001
            checks.append(
                unknown(
                    "benchmark versions ({})".format(row["id"]),
                    "the plugin could not be loaded: {}".format(str(error)[:160]),
                    "The benchmark is active in D1 but not importable here. "
                    "Confirm its submodule is checked out.",
                )
            )
            continue
        disagreements = [
            "{} row={!r} plugin={!r}".format(job_field, row[job_field], getattr(plugin, attribute, None))
            for job_field, attribute in VERSION_FIELDS
            if getattr(plugin, attribute, None) != row[job_field]
        ]
        if disagreements:
            checks.append(
                bad(
                    "benchmark versions ({})".format(row["id"]),
                    "; ".join(disagreements),
                    "_load_benchmark refuses the run at contract_check on any "
                    "of these. Apply the pending migrations with "
                    "`pnpm db:migrate:local`, and redeploy Modal if the plugin "
                    "in this checkout is newer than the deployed image.",
                )
            )
        else:
            checks.append(
                ok(
                    "benchmark versions ({})".format(row["id"]),
                    "row and installed plugin agree on all five compared fields",
                )
            )
    return checks


# --------------------------------------------------------------------------
# Assembly
# --------------------------------------------------------------------------


def run_checks(
    values: Dict[str, str],
    node: Optional[str],
    workdir: Path,
    benchmarks: Optional[Sequence[Dict[str, Any]]],
    benchmarks_reason: str = "",
) -> List[Check]:
    checks: List[Check] = []
    checks.extend(check_required_variables(values))
    checks.append(check_execution_provider(values))
    checks.append(check_runner_url(values))
    checks.append(check_callback_origin(values))
    checks.append(check_image_digest(values))

    if node is None:
        no_node = (
            "Install node (the repository already needs it for the portal) and "
            "run this again. Until then the signing boundary is unproven."
        )
        checks.append(unknown("signing agreement", "node is not on PATH", no_node))
        checks.append(unknown("signature verification", "node is not on PATH", no_node))
        checks.append(unknown("callback signing", "node is not on PATH", no_node))
        checks.append(unknown("runtime limits", "node is not on PATH", no_node))
        return checks

    worker_signer = node_signer(node, workdir)
    checks.append(compare_signatures(worker_signer, python_signer))
    checks.append(check_verify_accepts_and_refuses(worker_signer))
    checks.append(check_callback_direction(worker_signer))

    if not benchmarks:
        checks.append(
            unknown(
                "runtime limits",
                benchmarks_reason or "no active benchmarks were found",
                "Run `pnpm db:migrate:local` from the repository root to build "
                "the local D1 database, then run this again. Without it there "
                "is nothing to build a real job from.",
            )
        )
        return checks

    floors = sandbox_floors(MODAL_APP.read_text(encoding="utf-8"))
    for row in benchmarks:
        try:
            job = build_run_job(node, workdir, values, row)
        except Exception as error:  # noqa: BLE001
            # buildRunJob throws on a bad PUBLIC_ORIGIN before it reads
            # anything benchmark-specific, so the same failure would repeat
            # once per active benchmark and bury every other line. Report it
            # once and stop building jobs; the origin check above already
            # names the fix.
            checks.append(
                unknown(
                    "runtime limits",
                    "buildRunJob could not be run: {}".format(_node_error(error)),
                    "This runs the Worker's own buildRunJob rather than a copy "
                    "of its defaults. It throws on a PUBLIC_ORIGIN that is not "
                    "https, which is the usual cause. No job was checked.",
                )
            )
            break
        checks.extend(check_job_is_acceptable(row["id"], job))
        checks.append(check_job_bounds(node, workdir, row["id"], job))
        checks.append(check_runtime_floors(job, floors))
    checks.extend(check_benchmark_versions(benchmarks))
    return checks


def check_deployed_agrees(origin: str) -> List[Check]:
    """Whether the environment that will actually run the job is current.

    Every other check here reads this checkout and the local D1. A dispatch
    goes somewhere else, and that somewhere can be arbitrarily old. Measured
    on 2026-08-24, before this check existed: the deployed portal reported
    `scorerVersion: 1` and `datasetVersion: practice-v1` for all three
    benchmarks, which are the placeholder values migration 0005 writes as
    column defaults. So the deployed database had never run migration 0013
    onward, and every benchmark row there described a benchmark that no
    longer exists. It also listed `audio-recognition`, an id that has since
    been replaced.

    A dispatch into that would have failed at contract_check, correctly, for
    a reason with nothing to do with whether dispatch works. That is the
    worst kind of first run: it teaches you nothing and it looks like it
    taught you something.

    The check is read-only and needs no credentials: `/api/benchmarks` is
    public. It reports what disagrees rather than deciding what to do about
    it, because the fix differs (apply migrations, or redeploy the worker,
    or both) and only a person knows which environment they meant.
    """

    url = origin.rstrip("/") + "/api/benchmarks"
    try:
        # curl rather than urllib: Cloudflare answers urllib's default agent
        # with 403, which reads as "the portal is down" and is not.
        result = subprocess.run(
            ["curl", "-s", "--max-time", "20", url],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return [
                unknown(
                    "deployed benchmarks",
                    "{} did not answer".format(url),
                    "Confirm the origin is right and reachable. This check is "
                    "read-only and needs no credentials.",
                )
            ]
        deployed = {row["id"]: row for row in json.loads(result.stdout)}
    except Exception as error:  # noqa: BLE001
        return [
            unknown(
                "deployed benchmarks",
                "could not read {}: {}".format(url, str(error)[:120]),
                "This check is read-only. A failure here is about reachability, "
                "not about the dispatch path.",
            )
        ]

    try:
        from cogbench.plugins import load_benchmark
    except Exception as error:  # noqa: BLE001
        return [
            unknown(
                "deployed benchmarks",
                "cogbench could not be imported: {}".format(str(error)[:120]),
                "Use an interpreter with the benchmark packages; "
                "scripts/make_test_env.py builds one.",
            )
        ]

    # The five fields the runner compares at contract_check, in the shape the
    # public API reports them.
    wire = {
        "benchmark_version": "version",
        "contract_version": "contractVersion",
        "plugin_version": "pluginVersion",
        "dataset_version": "datasetVersion",
        "scorer_version": "scorerVersion",
    }

    # Only rows a run can actually be started against. A benchmark that was
    # superseded stays in the table with active=0 so old runs keep resolving
    # their own version, and comparing those against today's plugin reports
    # drift that is a deliberate record rather than a problem. Measured: the
    # first version of this check called the deployed environment a month
    # stale on the strength of three retired rows, and the local database
    # holds the same three.
    live = {
        identifier: row
        for identifier, row in deployed.items()
        if row.get("active", True)
    }

    checks: List[Check] = []
    for identifier in sorted(live):
        try:
            plugin = load_benchmark(identifier)
        except Exception:  # noqa: BLE001
            checks.append(
                bad(
                    "deployed benchmark ({})".format(identifier),
                    "the deployed portal offers this benchmark and this "
                    "checkout has no plugin for it",
                    "The deployed database is describing a benchmark that no "
                    "longer exists. Apply the pending migrations to that "
                    "environment.",
                )
            )
            continue
        disagreements = [
            "{}: deployed={!r} local={!r}".format(
                field, live[identifier].get(field), getattr(plugin, attribute, None)
            )
            for attribute, field in wire.items()
            if str(getattr(plugin, attribute, None)) != str(live[identifier].get(field))
        ]
        if disagreements:
            checks.append(
                bad(
                    "deployed benchmark ({})".format(identifier),
                    "; ".join(disagreements),
                    "The job would be refused at contract_check. Apply the "
                    "pending migrations to that environment before "
                    "dispatching to it.",
                )
            )
        else:
            checks.append(
                ok(
                    "deployed benchmark ({})".format(identifier),
                    "deployed row and local plugin agree on all five fields",
                )
            )
    return checks


#: Where the runner posts events. The handler registers on the `api` router
#: and `index.ts` mounts that at `/api`, so the full path carries that prefix.
#: Probing `/internal/v1/runner/events` answers 405 from the single-page app
#: catch-all, which reads exactly like "the route is not deployed" and is not.
#: Measured: the wrong path said 405 on a local dev server running the current
#: commit, which is what caught it.
CALLBACK_PATH = "/api/internal/v1/runner/events"

def check_callback_route_is_live(origin: str) -> Check:
    """Whether the deployed portal can receive a runner event at all.

    One unsigned POST separates two states that look identical from the
    outside and have nothing to do with each other:

    ``401``
        The route exists and rejected the request for want of a signature.
        `verifyRunnerEvent` runs before the body is parsed, so this is the
        correct answer to an unsigned POST and it proves the whole return
        half is deployed.
    ``405``
        The route is not there. The SPA catch-all answers a GET with 200,
        which is why this has to be a POST: a GET says the origin is up and
        says nothing about whether it can take an event.

    Measured on 2026-08-24: both deployed environments answered 405 with an
    empty body. A dispatch then would have run to completion in Modal and
    posted every event into a void, and the run would have sat in `queued`
    until the stale reaper resolved it an hour later. That is the failure
    this check exists to make impossible to walk into, because it looks like
    a hung run rather than a missing route.

    Nothing is signed here on purpose. A valid signature would prove more and
    would need the secret; this needs no credentials and can be run by anyone
    against any environment.
    """

    url = origin.rstrip("/") + CALLBACK_PATH
    try:
        result = subprocess.run(
            [
                "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                "--max-time", "20", "-X", "POST", url,
                "-H", "content-type: application/json", "-d", "{}",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        status = (result.stdout or "").strip()
    except Exception as error:  # noqa: BLE001
        return unknown(
            "callback route",
            "could not reach {}: {}".format(url, str(error)[:120]),
            "This is a reachability failure, not a dispatch failure.",
        )

    if status == "401":
        return ok(
            "callback route",
            "deployed and refusing an unsigned event, which is the right answer",
        )
    if status == "501":
        return bad(
            "callback route",
            "the route is deployed and RUNNER_SIGNING_SECRET is not set there",
            "`verifyRunnerEvent` returns 501 before it looks at the signature "
            "when the secret is absent, so every event the sandbox posts is "
            "refused and the run strands. Set it with "
            "`wrangler secret put RUNNER_SIGNING_SECRET --env <environment>`, "
            "using the same value as the Modal secret.",
        )
    if status == "405":
        return bad(
            "callback route",
            "{} answered 405, so nothing handles a POST there".format(url),
            "That environment is running a build without the runner callback. "
            "Deploy the worker from this commit before dispatching to it, or "
            "every event the sandbox posts is lost and the run strands in "
            "`queued` until the stale reaper resolves it.",
        )
    return unknown(
        "callback route",
        "{} answered {}".format(url, status or "nothing"),
        "Expected 401 (live, unsigned rejected), 501 (live, no secret), or "
        "405 (nothing there). "
        "Anything else needs a person to look at it.",
    )


def _node_error(error: Exception) -> str:
    """The message out of a node stack trace, not the frame it happened in.

    Same reasoning as `_last_error_line` in modal_app.py: node prints the
    offending source line and a caret above the message, and the first line of
    that is our temporary file's path, which tells a reader nothing.
    """

    lines = [line.strip() for line in str(error).splitlines() if line.strip()]
    for line in lines:
        # Colon-space, not a bare colon. node's first stderr line is the
        # offending file as a URL (`file:///tmp/...mts:18`), whose text before
        # the colon is `file`, which is a valid identifier; requiring the space
        # is what separates a thrown message from a path.
        head, separator, _ = line.partition(": ")
        if separator and head.isidentifier():
            return line
    return lines[-1] if lines else "no detail"


def report(checks: Sequence[Check], stream=sys.stdout) -> int:
    width = max((len(check.name) for check in checks), default=10)
    for check in checks:
        print("  {:<{}}  {}  {}".format(check.name, width, check.status.ljust(7), check.reason), file=stream)
        if check.status != PASS and check.fix:
            print("  {:<{}}           {}".format("", width, check.fix), file=stream)
    failed = [check for check in checks if check.status == FAIL]
    unresolved = [check for check in checks if check.status == UNKNOWN]
    print("", file=stream)
    if not failed and not unresolved:
        print("READY. {} checks passed. Nothing here proves the deployed "
              "endpoint agrees; run tools/verify_dispatch.py for that.".format(len(checks)),
              file=stream)
        return 0
    print(
        "NOT READY. {} passed, {} failed, {} could not be checked.".format(
            len(checks) - len(failed) - len(unresolved), len(failed), len(unresolved)
        ),
        file=stream,
    )
    if unresolved:
        print(
            "A check that could not run is not a check that passed. "
            "Resolve it or dispatch knowing that boundary is unproven.",
            file=stream,
        )
    return 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--env-file",
        type=Path,
        default=DEFAULT_ENV_FILE,
        help="dotenv file to read (default: apps/portal/.dev.vars)",
    )
    parser.add_argument(
        "--deployed",
        metavar="ORIGIN",
        help=(
            "also check a deployed portal, e.g. "
            "https://cogportal-dev.sillion.app. Read-only and unauthenticated: "
            "it reads /api/benchmarks and compares the five version fields the "
            "runner compares at contract_check. Every other check here reads "
            "this checkout, which is not where a dispatch lands."
        ),
    )
    arguments = parser.parse_args(argv)

    values, found = load_values(arguments.env_file, dict(os.environ))
    print("preflight for one real Modal dispatch\n")
    if found is None:
        print("  no env file at {}; reading the process environment only".format(arguments.env_file))
    else:
        print("  env file {}".format(found))
    node = shutil.which("node")
    print("  node     {}".format(node or "not found on PATH"))

    database = local_d1_path()
    benchmarks: Optional[List[Dict[str, Any]]] = None
    reason = ""
    if database is None:
        reason = "no local D1 database under apps/portal/.wrangler"
        print("  local D1 not found")
    else:
        try:
            benchmarks = read_active_benchmarks(database)
            print("  local D1 {} ({} active benchmarks)".format(database.name[:12], len(benchmarks)))
        except sqlite3.Error as error:
            reason = "the local D1 database could not be read: {}".format(str(error)[:120])
            print("  local D1 unreadable")
    print("")

    with tempfile.TemporaryDirectory(prefix="cogworks-preflight-") as directory:
        checks = run_checks(values, node, Path(directory), benchmarks, reason)
        if arguments.deployed:
            checks.append(check_callback_route_is_live(arguments.deployed))
            checks.extend(check_deployed_agrees(arguments.deployed))
        status = report(checks)

    print("")
    print("Deployed environments do not read this file. apps/portal/wrangler.jsonc")
    print("carries its own EXECUTION_PROVIDER for staging and production, and")
    print("changing it is a separate, deliberate decision.")
    return status


if __name__ == "__main__":
    raise SystemExit(main())
