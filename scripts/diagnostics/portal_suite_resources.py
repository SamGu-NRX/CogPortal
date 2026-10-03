"""Measure four portal-suite runs on one hosted Linux VM, without tuning CI.

Five earlier jobs received a runner shutdown signal without assertion failures.
This experiment measures file concurrency; it cannot recover those jobs' missing
host telemetry or establish causation from a small number of successful runs.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def number_file(path):
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None


def memory_sample(session_id):
    """RSS is summed across this command's session and may double-count pages."""
    rss_kib = 0
    processes = 0
    page_kib = os.sysconf("SC_PAGE_SIZE") // 1024
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(") ", 1)[1].split()
            if int(fields[3]) == session_id:
                rss_kib += int(fields[21]) * page_kib
                processes += 1
        except (OSError, ValueError, IndexError):
            continue  # A process may exit between directory listing and read.
    memory = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        if key in {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}:
            memory[key + "KiB"] = int(value.split()[0])
    cgroup = Path("/sys/fs/cgroup")
    try:
        relative = next(line[3:] for line in Path("/proc/self/cgroup").read_text().splitlines()
                        if line.startswith("0::"))
        nested = cgroup / relative.lstrip("/")
        if (nested / "memory.current").is_file():
            cgroup = nested
    except (OSError, StopIteration):
        pass
    events = None
    try:
        events = {key: int(value) for key, value in
                  (line.split() for line in (cgroup / "memory.events").read_text().splitlines())}
    except (OSError, ValueError):
        pass
    return {"sessionRssKiB": rss_kib, "sessionProcesses": processes, **memory,
            "cgroupCurrentBytes": number_file(cgroup / "memory.current"),
            "cgroupPeakBytes": number_file(cgroup / "memory.peak"), "cgroupEvents": events}


def test_counts(text):
    clean = ANSI.sub("", text)
    result = {}
    for name in ("tests", "pass", "fail", "cancelled", "skipped"):
        matches = re.findall(r"(?:^|\n)\s*(?:#|ℹ)?\s*" + name + r"\s+(\d+)\s*(?:\n|$)", clean)
        if matches:
            result[name] = int(matches[-1])
    return result


def stop_group(process):
    # Popen starts this group here; no other runner process is targeted.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def measure(command, cwd, output, label, timeout, sample_memory=memory_sample):
    log_path = output / (label + ".log")
    samples_path = output / (label + "-memory.jsonl")
    result = {"label": label, "timeoutSeconds": timeout, "state": "started"}
    result_path = output / (label + "-result.json")
    result_path.write_text(json.dumps(result, indent=2))
    begin = time.monotonic()
    maximum_rss = 0
    last_sample = None
    with log_path.open("x") as log, samples_path.open("x", buffering=1) as samples:
        process = subprocess.Popen(command, cwd=cwd,
                                   env=dict(os.environ, TSX_TSCONFIG_PATH="tsconfig.app.json"),
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            while True:
                elapsed = time.monotonic() - begin
                sample = {"seconds": round(elapsed, 3), **sample_memory(process.pid)}
                samples.write(json.dumps(sample) + "\n")
                maximum_rss = max(maximum_rss, sample["sessionRssKiB"])
                last_sample = sample
                code = process.poll()
                if code is not None:
                    result.update(state="exited", exit=code)
                    break
                if elapsed >= timeout:
                    result.update(state="timed_out", exit=124)
                    break
                time.sleep(min(1, timeout - elapsed))
        except BaseException:
            result.update(state="interrupted", exit=130)
            raise
        finally:
            stop_group(process)
            result.update(seconds=round(time.monotonic() - begin, 3),
                          maxSummedSessionRssKiB=maximum_rss, lastSample=last_sample)
            result["counts"] = test_counts(log_path.read_text(errors="replace"))
            result_path.write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
    return result


def self_test():
    assert test_counts("# tests 7\n# pass 6\n# fail 1\n") == {"tests": 7, "pass": 6, "fail": 1}
    assert test_counts("ℹ tests 2\nℹ pass 2\nℹ fail 0\n") == {"tests": 2, "pass": 2, "fail": 0}
    with tempfile.TemporaryDirectory(prefix="portal-resource-selftest-") as directory:
        output = Path(directory)
        # Control-flow checks run on macOS too; only the hosted experiment
        # claims Linux process or cgroup measurements.
        sample = memory_sample if sys.platform == "linux" else lambda _pid: {"sessionRssKiB": 0}
        ok = measure([sys.executable, "-c", "print('# tests 1\\n# pass 1\\n# fail 0')"], ROOT, output, "ok", 3, sample)
        assert ok["exit"] == 0 and ok["counts"]["tests"] == 1
        failed = measure([sys.executable, "-c", "raise SystemExit(7)"], ROOT, output, "failed", 3, sample)
        assert failed["exit"] == 7
        timed = measure([sys.executable, "-c", "import time; time.sleep(10)"], ROOT, output, "deadline", 0.1, sample)
        assert timed["exit"] == 124 and timed["state"] == "timed_out"
    print("Parser, successful child, failing child and deadline checks passed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--source-root", type=Path, default=ROOT)
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if sys.platform != "linux":
        parser.error("resource measurement requires Linux /proc")
    if args.output is None or not 1 <= args.timeout <= 240:
        parser.error("--output and a timeout between 1 and 240 seconds are required")
    args.output.mkdir(parents=True, exist_ok=False)
    source_root = args.source_root.resolve()
    portal = source_root / "apps/portal"
    files = sorted(str(path.relative_to(portal)) for path in (portal / "test").glob("*.test.ts"))
    assert files, "No portal test files found"
    metadata = json.loads(subprocess.check_output(["node", "-e", "console.log(JSON.stringify({node:process.version,parallelism:require('os').availableParallelism(),cpus:require('os').cpus().length,totalMemory:require('os').totalmem()}))"], text=True))
    metadata.update(commit=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source_root, text=True).strip(),
                    testFiles=len(files), order=["default", "serial", "serial", "default"],
                    limits="Summed RSS can double-count shared pages. Cgroup metrics may cover more than the suite and peak is cumulative. Four samples cannot identify earlier shutdown causes.")
    (args.output / "machine.json").write_text(json.dumps(metadata, indent=2))
    print(json.dumps(metadata), flush=True)
    results = []
    for index, mode in enumerate(metadata["order"], 1):
        label = str(index) + "-" + mode
        command = ["/usr/bin/time", "-v", "-o", str(args.output / (label + "-time.txt")), "pnpm", "exec", "tsx", "--test"]
        if mode == "serial":
            command.append("--test-concurrency=1")
        command.extend(files)
        results.append(measure(command, portal, args.output, label, args.timeout))
        (args.output / "summary.json").write_text(json.dumps(results, indent=2))
    complete = all(row.get("exit") == 0 and row["counts"].get("tests", 0) > 0 for row in results)
    same_counts = len({row["counts"].get("tests") for row in results}) == 1
    return 0 if complete and same_counts else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    sys.exit(main())
