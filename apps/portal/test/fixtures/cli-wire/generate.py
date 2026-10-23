"""Record the JSON bodies each pinned cogbench CLI sends to the portal.

The portal's request schemas are strict, so a field an installed CLI sends and
the portal doesn't declare turns that student's sync into a 400. The test in
test/request-body-limits.test.ts posts these recorded bodies to the real
routes, and that only proves something if the bodies come from the CLI itself.
So this script runs each pin's own python/cogbench (read with `git archive`,
never installed) with the network calls replaced by a recorder:

- report sync: a report saved with to_json(), read back with from_json() and
  posted the way `cogworks sync` does (cli.py: sync_report(..., json.loads(
  report.to_json())), which drops outputDigest);
- live run: `_start_live_run`, then `_LiveRun` progress events through
  completion (single events and the final batch), and a second run that fails;
- setup evidence (`_update_setup`) and the device-token poll.

The clock and uuid4 are fixed so a rerun writes the same files.

Run from the repository root, with the history holding both pins:

    python3 -I apps/portal/test/fixtures/cli-wire/generate.py
"""

import json
import pathlib
import subprocess
import sys
import tarfile
import tempfile

#: Every CLI a student can have installed. The test also requires a file for
#: the pin in apps/portal/src/lib/benchmark-packages.ts.
PINS = {
    "064400e9cf65874b87fe888fc6fd14a564095c5e": "staging and beta setup pin",
    "ac8ddafa014ac72613bf8f291f945344a914cc63": "alpha setup pin",
}

#: Runs inside a child interpreter with only the pin's source on sys.path.
RECORDER = r'''
import argparse, dataclasses, itertools, json, sys, time, uuid
from pathlib import Path

ticks = itertools.count()
time.time = lambda: 1_790_000_000 + next(ticks) * 0.25
ids = itertools.count(1)
uuid.uuid4 = lambda: uuid.UUID(int=next(ids))

from cogbench import cli, client
from cogbench.models import LocalReport, Metric, RepositoryState

PORTAL = "https://portal.invalid"
REPOSITORY = RepositoryState(
    repository_id=None, full_name="cogworks-demo/face-finder",
    sha="b" * 40, dirty=False, branch="main",
)
recorded = []

def record(path, body, answer):
    # A copy through JSON, which is what urllib puts on the wire.
    recorded.append({"path": path, "body": json.loads(json.dumps(body))})
    return answer

client.request_json = lambda portal, path, body=None, token=None, retry=False, timeout=15: record(
    path, body, {"status": "authorized", "token": "t" * 32, "expiresAt": 1}
)
cli.token_for = lambda portal: "cog_recorded"
cli._portal = lambda value: PORTAL
cli.repository_state = lambda root: REPOSITORY
cli.plugin_names = lambda group: ["vision-recognition"] if group.startswith("cogworks.benchmarks") else []
cli.start_local_run = lambda portal, token, run: record(
    "/api/v1/local-runs", run, {"sessionId": run["clientRunId"], "discord": "published"}
)
cli.send_local_run_event = lambda portal, token, session, event: record(
    "/api/v1/local-runs/{}/events".format(session), event, {"ok": True}
)
cli.send_local_run_event_batch = lambda portal, token, session, events: record(
    "/api/v1/local-runs/{}/events/batch".format(session), {"events": events}, {"ok": True}
)
cli.update_setup_checks = lambda portal, token, payload: record(
    "/api/v1/cli/setup/checks", payload, {"accepted": payload["checks"]}
)

def report():
    created = LocalReport.create(
        benchmark_id="vision-recognition", benchmark_version=1,
        contract_version="cogworks.submissions.v2", sdk_version="0.2.0", plugin_version="1",
        repository=REPOSITORY, started_at=1_790_000_000_000, finished_at=1_790_000_060_000,
        metrics=[
            Metric("recognition_score", "Recognition score", 0.875, None, True, True, 4,
                   help="The mean of known identification and the unknown lifecycle.", role="scored"),
            Metric("chance_floor", "Chance", 0.1, None, True, False, 3,
                   role="floor", relates_to="recognition_score"),
        ],
        diagnostics=["Known faces are identified at 92%. " * 12],
        predictions=[[0, 1], [1, 0]],
        weights_used=["models/W_embed.npy"],
        weights_uploaded=[{"path": "models/W_embed.npy", "sha256": "c" * 64, "size": 411_000}],
    )
    # cli.py sets the producing command the same way after the run.
    return dataclasses.replace(created, command="run")

# Sync reads the saved report back from disk before it posts it.
saved = LocalReport.from_json(report().to_json())
client.sync_report(PORTAL, "cog_recorded", json.loads(saved.to_json()))

args = argparse.Namespace(portal=PORTAL)
identity = {"benchmark_id": "vision-recognition", "benchmark_version": 1}

def settle(run):
    # The sender thread drops queued progress once a run closes, so wait for
    # each event to go out; otherwise which ones are recorded varies.
    run._events.join()

live = cli._start_live_run(args, identity, Path("."))
for step in (("preparing",), ("contract_check",), ("evaluating", 0, 4), ("evaluating", 4, 4), ("scoring",)):
    live.progress(*step)
    settle(live)
live.completed(report())
live._sender.join(timeout=10)

failing = cli._start_live_run(args, identity, Path("."))
failing.progress("preparing")
settle(failing)
failing.failed(TimeoutError("ran out of time"))
failing._sender.join(timeout=10)

cli._update_setup(None, ["clone", "environment"], Path("."), "vision-recognition")
client.poll_device_link(PORTAL, "d" * 40, 2, 10 ** 15)

# The sender thread posts the final single event while the parent posts the
# batch, so those two can arrive in either order.
def order(entry):
    body = entry["body"]
    return (entry["path"], body.get("sequence", -1) if isinstance(body, dict) else -1)

with open(sys.argv[1], "w", encoding="utf-8") as out:
    json.dump(sorted(recorded, key=order), out)
'''


def main() -> None:
    root = pathlib.Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
    out_dir = pathlib.Path(__file__).resolve().parent
    for sha, role in PINS.items():
        with tempfile.TemporaryDirectory(prefix="cli-wire-") as scratch:
            archive = pathlib.Path(scratch, "src.tar")
            with archive.open("wb") as stream:
                subprocess.run(
                    ["git", "-C", str(root), "archive", sha, "python/cogbench/src"],
                    stdout=stream, check=True,
                )
            with tarfile.open(archive) as tar:
                tar.extractall(scratch, filter="data")
            source = pathlib.Path(scratch, "python", "cogbench", "src")
            recorder = pathlib.Path(scratch, "recorder.py")
            recorder.write_text(RECORDER, encoding="utf-8")
            recording = pathlib.Path(scratch, "recorded.json")
            # -I keeps the user's site-packages and the working directory off
            # sys.path, so only the pin's source can be imported as cogbench.
            subprocess.run(
                [sys.executable, "-I", "-c",
                 "import runpy, sys; sys.path.insert(0, sys.argv[1]); sys.argv = sys.argv[2:]; runpy.run_path(sys.argv[0], run_name='__main__')",
                 str(source), str(recorder), str(recording)],
                cwd=scratch, check=True, capture_output=True, text=True,
            )
            output = recording.read_text(encoding="utf-8")
        document = {
            "pin": sha,
            "role": role,
            "generatedBy": "apps/portal/test/fixtures/cli-wire/generate.py",
            "requests": json.loads(output),
        }
        target = out_dir / "{}.json".format(sha[:8])
        target.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print("{}: {} requests".format(target.relative_to(root), len(document["requests"])))


if __name__ == "__main__":
    main()
