"""Does the deployed endpoint accept exactly what the portal sends, and nothing else?

`smoke_modal.py` proves the sandboxes work by calling `_prepare` and
`_evaluate_*` directly. It never touches `submit_job`, so the boundary the
portal actually crosses -- one signed HTTPS POST, verified against a Modal
secret -- has no coverage at all. That boundary has its own failure modes:
a signing secret that differs between the two sides, a key id mismatch, a
clock skew window, a schema the endpoint validates more strictly than the
portal builds.

This signs a real job with the same HMAC the Worker uses and posts it, then
checks that four unauthorized shapes are refused.

    RUNNER_SIGNING_SECRET=... python apps/runner-modal/tools/verify_dispatch.py

Without the secret it runs the rejection checks only, which still confirm the
endpoint is live and does not accept unsigned work. With `--spawn` an accepted
job actually runs on Modal; the default sends a job whose SHA does not exist,
so the endpoint accepts and spawns it and the run fails inside the sandbox
rather than costing a full evaluation.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

DEFAULT_URL = "https://samgu-nrx--cogworks-runner-submit-job.modal.run"

#: A SHA that is well-formed and does not exist, so an accepted job fails at
#: `git fetch` inside the prepare sandbox instead of running a real evaluation.
NONEXISTENT_SHA = "0" * 40


def signature(secret: str, timestamp: str, body: bytes) -> str:
    payload = timestamp.encode("ascii") + b"." + body
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def post(url: str, body: bytes, headers: dict) -> int:
    request = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except urllib.error.URLError as error:
        print("  network error: {}".format(error))
        return 0


def build_job(repo: str, sha: str) -> dict:
    """The same shape `buildRunJob` produces in runner.ts."""

    stamp = int(time.time())
    return {
        "protocolVersion": "1",
        "jobId": "job_verify_{}".format(stamp),
        "runId": "run_verify_{}".format(stamp),
        "mode": "practice",
        "preparedArtifactId": None,
        # Required whenever there is no prepared artifact (protocol.validate_job):
        # the portal sends the team's weight manifest here, empty when the
        # team trained nothing. Without it the endpoint answers 400 with an
        # empty body, which this tool reported as "boundary is not sound".
        "weights": [],
        "source": {
            "repositoryId": 0,
            "fullName": repo,
            "sha": sha,
            "archiveUrl": "https://api.github.com/repos/{}/tarball/{}".format(repo, sha),
        },
        "benchmark": {
            "id": "audio-identification",
            "version": 1,
            "contractVersion": "cogworks.submissions.v2",
            "pluginVersion": "0.1.0",
            "datasetVersion": "practice-v1",
            "scorerVersion": "identification-v1",
        },
        "runtime": {
            "pythonVersion": "3.8",
            "imageDigest": "verify",
            "cpu": 1,
            "memoryMb": 4096,
            "timeoutSeconds": 900,
            "maxOutputBytes": 8192,
        },
        # Never called: the job is refused or fails before any event is posted.
        "callback": {"url": "https://example.invalid/never", "keyId": "runner-v1"},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=os.environ.get("MODAL_RUNNER_URL", DEFAULT_URL))
    parser.add_argument("--repo", default="KrazeeCoder/week1-capstone-team4")
    parser.add_argument("--spawn", action="store_true",
                        help="use the real branch head, so an accepted job runs for real")
    arguments = parser.parse_args()

    secret = os.environ.get("RUNNER_SIGNING_SECRET", "")
    key_id = os.environ.get("RUNNER_SIGNING_KEY_ID", "runner-v1")
    print("endpoint {}\n".format(arguments.url))

    sha = NONEXISTENT_SHA
    if arguments.spawn:
        url = "https://api.github.com/repos/{}/commits?per_page=1".format(arguments.repo)
        request = urllib.request.Request(url, headers={"User-Agent": "cogworks-verify"})
        with urllib.request.urlopen(request, timeout=30) as response:
            sha = json.load(response)[0]["sha"]

    job = build_job(arguments.repo, sha)
    body = json.dumps(job).encode("utf-8")
    now = str(int(time.time()))

    failures = 0

    def check(label: str, headers: dict, expected: int, payload: bytes = body) -> None:
        nonlocal failures
        status = post(arguments.url, payload, headers)
        ok = status == expected
        failures += 0 if ok else 1
        print("  {:<38} {} (expected {}){}".format(
            label, status, expected, "" if ok else "   <-- WRONG"))

    print("refusals:")
    check("no signature headers at all", {"Content-Type": "application/json"}, 401)
    check("unknown key id", {
        "Content-Type": "application/json",
        "X-Cogworks-Key-Id": "not-our-key",
        "X-Cogworks-Timestamp": now,
        "X-Cogworks-Signature": "v1=" + "0" * 64,
    }, 401)
    check("right key id, wrong signature", {
        "Content-Type": "application/json",
        "X-Cogworks-Key-Id": key_id,
        "X-Cogworks-Timestamp": now,
        "X-Cogworks-Signature": "v1=" + "0" * 64,
    }, 401)

    if not secret:
        print("\nRUNNER_SIGNING_SECRET is not set, so the accept path was not checked.")
        print("Set it to the value in the cogworks-runner-signing Modal secret.")
        return 1 if failures else 0

    signed = {
        "Content-Type": "application/json",
        "X-Cogworks-Key-Id": key_id,
        "X-Cogworks-Timestamp": now,
        "X-Cogworks-Signature": "v1=" + signature(secret, now, body),
    }
    # A stale timestamp must fail even with a valid signature over that
    # timestamp, or a captured request could be replayed indefinitely.
    stale = str(int(time.time()) - 3600)
    check("valid signature, hour-old timestamp", {
        **signed,
        "X-Cogworks-Timestamp": stale,
        "X-Cogworks-Signature": "v1=" + signature(secret, stale, body),
    }, 401)
    # A body edited after signing must fail: the signature covers the body.
    tampered = json.dumps({**job, "mode": "official"}).encode("utf-8")
    check("signature valid, body swapped", signed, 401, tampered)

    print("\nacceptance:")
    check("correctly signed job", signed, 202)

    print()
    if failures:
        print("{} check(s) failed. The portal-to-Modal boundary is not sound.".format(failures))
        return 1
    print("dispatch boundary verified: signed jobs accepted, everything else refused.")
    if not arguments.spawn:
        print("The accepted job names a SHA that does not exist, so it fails in the")
        print("prepare sandbox rather than running an evaluation.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
