"""Post one signed synthetic event to a deployed portal, and read the answer.

The preflight's signing check proves the Worker and the runner compute the
same signature over the same bytes. That is a statement about two
implementations of an algorithm. It says nothing about whether the secret
deployed to Cloudflare is the secret in the Modal secret, and a key that
differs between them fails exactly like a signing bug: one 401, in the middle
of a full run, after a sandbox has already been paid for.

This separates that failure out. It exercises the deployed route, the
deployed secret, verification, and the skew window, with no sandbox involved
and nothing to clean up afterwards.

    RUNNER_SIGNING_SECRET=... python apps/runner-modal/tools/probe_callback.py \
      --origin https://cogportal-dev.sillion.app

What each answer means:

``401 unsigned, 404 signed``
    Everything works. The route is live, the secret matches, and the event was
    rejected only because its run id does not exist, which is the correct
    answer to an event about an imaginary run. This is the pass.

    A 400 is also a pass for the same reason one step earlier: the signature
    was accepted and the body was refused. Either way the secret is proven,
    which is the one thing this tool exists to establish.
``401 signed``
    The route is live and the secret does not match. The one failure this
    tool exists to find.
``405``
    The route is not deployed. Nothing else here can be interpreted.

Deliberately uses a run id that cannot exist, so a pass writes nothing. The
event never reaches the database because the run lookup fails first.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import subprocess
import sys
import time
import uuid

#: A run id no real run can have. `run_` is the real prefix; the rest names
#: this tool so anyone who finds it in a log knows what made it.
#: Where the runner posts events. The handler registers on the `api` router
#: and `index.ts` mounts that at `/api`, so the full path carries that prefix.
#: Probing `/internal/v1/runner/events` answers 405 from the single-page app
#: catch-all, which reads exactly like "the route is not deployed" and is not.
#: Measured: the wrong path said 405 on a local dev server running the current
#: commit, which is what caught it.
CALLBACK_PATH = "/api/internal/v1/runner/events"

PROBE_RUN_ID = "run_probe_callback_does_not_exist"


def signature(secret: str, timestamp: str, body: str) -> str:
    """The Worker's own construction: HMAC-SHA256 over `timestamp.body`.

    Written out rather than imported because the Worker's copy is TypeScript
    running on WebCrypto. Keeping this to eleven lines of stdlib is what makes
    it worth having as an independent check: two implementations agreeing is
    evidence, one implementation calling itself is not.
    """

    payload = "{}.{}".format(timestamp, body).encode("utf-8")
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def post(url: str, body: str, headers: dict) -> str:
    """The HTTP status, as a string, or "" if the request did not complete.

    curl rather than urllib: Cloudflare answers urllib's default user agent
    with 403, which reads as a portal failure and is not one.
    """

    argv = ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20", "-X", "POST", url]
    for name, value in headers.items():
        argv += ["-H", "{}: {}".format(name, value)]
    argv += ["-d", body]
    result = subprocess.run(argv, capture_output=True, text=True, check=False)
    return (result.stdout or "").strip()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--origin", required=True, help="e.g. https://cogportal-dev.sillion.app")
    parser.add_argument(
        "--key-id",
        default=os.environ.get("RUNNER_SIGNING_KEY_ID", "runner-v1"),
        help="must match the deployed RUNNER_SIGNING_KEY_ID (default: runner-v1)",
    )
    arguments = parser.parse_args(argv)

    secret = os.environ.get("RUNNER_SIGNING_SECRET", "")
    url = arguments.origin.rstrip("/") + CALLBACK_PATH
    print("callback probe against {}\n".format(url))

    unsigned = post(url, "{}", {"content-type": "application/json"})
    print("  unsigned POST      {}".format(unsigned or "no answer"))
    if unsigned == "405":
        print("\n  Nothing handles a POST there. Deploy the worker from a")
        print("  commit that has the route before reading anything else here.")
        return 1
    if unsigned == "501":
        print("\n  The route is deployed and its signing secret is not set.")
        print("  verifyRunnerEvent returns 501 before it looks at a signature")
        print("  when the secret is absent, so every event a sandbox posts is")
        print("  refused and the run strands in `queued`.")
        print("  Set it with: wrangler secret put RUNNER_SIGNING_SECRET --env <environment>")
        return 1
    if unsigned != "401":
        print("\n  Expected 401 from a live route. {} needs a person.".format(unsigned))
        return 1

    if not secret:
        print("\n  Route is live and refusing unsigned events, which is correct.")
        print("  Set RUNNER_SIGNING_SECRET to also check that the deployed")
        print("  secret matches; without it the key is unproven.")
        return 1

    # Shaped to pass RunEventV1Schema (packages/contracts/src/protocol.ts).
    # The first version of this used "phase": "queued", which fails validation
    # twice over: the status variant's field is `status`, `queued` is not in
    # its enum, and `occurredAt` is required. A signed event that cannot parse
    # is refused at 400 rather than reaching the run lookup, so the probe
    # still distinguished a good secret from a bad one and this document said
    # to expect the wrong number for a pass.
    event = {
        "protocolVersion": "1",
        "eventId": "evt_{}".format(uuid.uuid4().hex[:16]),
        "runId": PROBE_RUN_ID,
        "sequence": 1,
        "occurredAt": int(time.time() * 1000),
        "type": "status",
        "status": "preparing",
    }
    body = json.dumps(event, separators=(",", ":"))
    timestamp = str(int(time.time()))
    signed = post(
        url,
        body,
        {
            "content-type": "application/json",
            "X-Cogworks-Key-Id": arguments.key_id,
            "X-Cogworks-Timestamp": timestamp,
            "X-Cogworks-Signature": "v1={}".format(signature(secret, timestamp, body)),
        },
    )
    print("  signed POST        {}".format(signed or "no answer"))

    if signed == "401":
        print("\n  The route is live and the secret does not match. This is the")
        print("  failure worth finding here: it is indistinguishable from a")
        print("  signing bug in a full run, and it is not one.")
        print("  Compare the Cloudflare secret with the Modal secret.")
        return 1
    if signed in ("404", "400", "422"):
        print("\n  Signature accepted. The event was then refused because its")
        print("  run does not exist, which is the right answer to an event")
        print("  about an imaginary run and is the pass for this probe.")
        return 0
    if signed in ("200", "204"):
        print("\n  Accepted outright. Unexpected for a run id that cannot")
        print("  exist, and worth understanding before dispatching.")
        return 1
    print("\n  {} is not an answer this tool knows how to read.".format(signed))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
