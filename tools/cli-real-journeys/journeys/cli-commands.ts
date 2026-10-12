import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CliHome, env, type CliProcess } from "../support/cli.ts";
import { TeamRepository } from "../support/git-fixture.ts";
import { linkThroughBrowser } from "../support/link.ts";
import { Portal } from "../support/portal.ts";
import { readStackInfo } from "../support/stack-info.ts";
import { Case } from "./harness.ts";
import { SUBMISSION_PY } from "./submission.ts";

/**
 * Every `cogworks` command, on one Python, with the failures a student meets
 * on an ordinary day. run-all.sh runs this once per supported interpreter
 * (3.8, 3.11, 3.13) against a fresh environment holding this branch's CLI and
 * the Week 1 audio benchmark; CLI_LABEL names the cell in every receipt.
 *
 * Each command's normal path and its adversarial set:
 *   check   in the team repository; outside any repository; an unknown benchmark
 *   test    the working submission; a submission whose enroll raises
 *   run     the working submission; Ctrl-C during a hanging submission
 *   report  the saved report; no saved report; a corrupt report file
 *   link    a 503 at the start request; then a real browser approval
 *   status  linked; not linked; connections dropped by the shaper
 *   sync    connections dropped (the report stays local), then recovery;
 *           not linked
 *   --live  the inactive Week 1 benchmark is refused by name
 * The successful --live run needs the Week 3 data and runs once, in
 * benchmark-real-run.ts. The shaper sits in front of the real Worker; faults
 * are injected there and cleared after each case.
 */
const run = promisify(execFile);
const LABEL = env("CLI_LABEL");
const VENV_BIN = env("VENV_MATRIX");
const BENCHMARK = "audio-identification";
const info = await readStackInfo();
const portal = await Portal.create();
await portal.devLogin("journey-student", { demo: true });

const TRACEBACK = /Traceback \(most recent call last\)/;
const BROKEN_MARK = "journey-broken-adapter: enroll failed on purpose";

const BROKEN_SUBMISSION_PY = `${SUBMISSION_PY}

class _Broken(SpectralMatcher):
    def enroll(self, song_id, samples, sample_rate):
        raise RuntimeError("${BROKEN_MARK}")


def create_submission(resources=None):
    return _Broken(resources)
`;

const HANGING_SUBMISSION_PY = `${SUBMISSION_PY}

import time as _time


class _Hanging(SpectralMatcher):
    def enroll(self, song_id, samples, sample_rate):
        _time.sleep(600)


def create_submission(resources=None):
    return _Hanging(resources)
`;

async function shape(mode: "normal" | "fail_5xx" | "drop", count = 1): Promise<void> {
  const response = await fetch(`${info.shaperControlOrigin}/__shape__`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, count }),
  });
  if (response.status !== 200) throw new Error(`shaper control answered ${response.status} for ${mode}`);
}

function teamRepo(files: Record<string, string> = { "submission.py": SUBMISSION_PY }): Promise<TeamRepository> {
  return TeamRepository.create({ originFullName: "cogworks-demo/face-finder", files });
}

async function savedReports(repoPath: string): Promise<string[]> {
  return (await readdir(join(repoPath, ".cogbench", "reports")).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort();
}

/** The first JSON document a `--json` command printed, or null. The CLI
 * prints it with two-space indentation, so it starts with "{" and ends with
 * "}" each at the start of a line; stderr lines may sit around it. */
function jsonDocument(output: string): any | null {
  const starts = [...output.matchAll(/^\{/gm)].map((match) => match.index ?? 0);
  const ends = [...output.matchAll(/^\}/gm)].map((match) => (match.index ?? 0) + 1);
  for (const start of starts) {
    for (const end of ends) {
      if (end <= start) continue;
      try {
        return JSON.parse(output.slice(start, end));
      } catch {
        // not a whole document yet
      }
    }
  }
  return null;
}

/** The reportId of a saved report file in a repository. */
async function reportIdOf(repoPath: string, name: string): Promise<string> {
  const raw = await readFile(join(repoPath, ".cogbench", "reports", name), "utf8");
  const parsed = JSON.parse(raw) as { reportId?: unknown; id?: unknown };
  return String(parsed.reportId ?? parsed.id ?? "");
}

async function finish(case_: Case, label: string, process_: CliProcess, ms: number): Promise<number> {
  const exit = await process_.exited(ms);
  case_.command(label, exit, process_.output());
  return exit;
}

const named = (name: string): string => `${name}-${LABEL}`;
const cases = {
  version: new Case("cli-commands", named("version"), ["installed CLI"]),
  check: new Case("cli-commands", named("check"), ["installed CLI", "benchmark package", "team repo"]),
  checkAdversarial: new Case("cli-commands", named("check-adversarial"), ["installed CLI", "benchmark package"]),
  test: new Case("cli-commands", named("test"), ["installed CLI", "benchmark package", "team repo"]),
  testBroken: new Case("cli-commands", named("test-broken-adapter"), ["installed CLI", "benchmark package", "team repo"]),
  run: new Case("cli-commands", named("run-and-report"), ["installed CLI", "benchmark package", "team repo"]),
  runInterrupted: new Case("cli-commands", named("run-interrupted"), ["installed CLI", "benchmark package", "team repo"]),
  reportAdversarial: new Case("cli-commands", named("report-adversarial"), ["installed CLI", "team repo"]),
  unlinked: new Case("cli-commands", named("unlinked-status-and-sync"), ["installed CLI"]),
  link: new Case("cli-commands", named("link"), ["installed CLI", "shaper", "portal Worker", "Portal SPA"]),
  status: new Case("cli-commands", named("status"), ["installed CLI", "shaper", "portal Worker"]),
  sync: new Case("cli-commands", named("sync-drop-then-recover"), ["installed CLI", "shaper", "portal Worker", "D1"]),
  live: new Case("cli-commands", named("live-inactive-refused"), ["installed CLI", "shaper", "portal Worker"]),
};

// One linked HOME and one repository with a saved report carry the portal
// cases; they are created as the cases that need them run.
const home = await CliHome.create(VENV_BIN);
const repo = await teamRepo();
let reportId = "";
let linked = false;

try {
  await cases.version.run(async () => {
    const case_ = cases.version;
    const python = join(VENV_BIN, "python");
    const installed = (await run(python, ["-c", "import cogbench, platform; print(cogbench.__version__); print(platform.python_version())"])).stdout.trim().split("\n");
    const version = home.start(["--version"]);
    const exit = await finish(case_, "cogworks --version", version, 30_000);
    case_.expect(exit === 0 && version.output().trim() === installed[0], `cogworks --version prints the installed version on Python ${installed[1]}`, `exit ${exit}; printed ${version.output().trim()}; installed ${installed[0]}`);
  });

  await cases.check.run(async () => {
    const case_ = cases.check;
    const check = home.start(["check", "--benchmark", BENCHMARK, "--json"], { cwd: repo.path });
    const exit = await finish(case_, `cogworks check --benchmark ${BENCHMARK} --json (team repository)`, check, 300_000);
    const report = jsonDocument(check.output());
    case_.expect(exit === 0, "check passes in the team repository", `exit ${exit}`);
    case_.expect(
      report?.gitRepository === true && report?.repositoryFullName === "cogworks-demo/face-finder" && report?.submissionLoadable === true,
      "check found the repository and the submission",
      JSON.stringify(report ?? {}).slice(0, 400),
    );
  });

  await cases.checkAdversarial.run(async () => {
    const case_ = cases.checkAdversarial;
    const outside = home.start(["check", "--benchmark", BENCHMARK, "--json"]);
    const outsideExit = await finish(case_, "cogworks check --json (outside any repository)", outside, 300_000);
    const outsideReport = jsonDocument(outside.output());
    case_.expect(
      outsideExit === 2 && outsideReport?.gitRepository === false && !TRACEBACK.test(outside.output()),
      "outside a repository, check exits 2 and says there is no git repository",
      `exit ${outsideExit}; gitRepository=${JSON.stringify(outsideReport?.gitRepository)}`,
    );
    const unknown = home.start(["check", "--benchmark", "no-such-benchmark", "--json"], { cwd: repo.path });
    const unknownExit = await finish(case_, "cogworks check --benchmark no-such-benchmark --json", unknown, 120_000);
    const unknownReport = jsonDocument(unknown.output());
    case_.expect(
      unknownExit === 2 && unknownReport?.benchmarkInstalled === false && !TRACEBACK.test(unknown.output()),
      "an unknown benchmark exits 2 and reports it is not installed",
      `exit ${unknownExit}; benchmarkInstalled=${JSON.stringify(unknownReport?.benchmarkInstalled)}`,
    );
  });

  await cases.test.run(async () => {
    const case_ = cases.test;
    const test = home.start(["test", "--benchmark", BENCHMARK, "--json"], { cwd: repo.path });
    const exit = await finish(case_, `cogworks test --benchmark ${BENCHMARK} --json`, test, 600_000);
    const report = jsonDocument(test.output());
    case_.expect(exit === 0, "the small case scored the submission", `exit ${exit}; ${test.output().slice(-300)}`);
    case_.expect(Array.isArray(report?.metrics) && report.metrics.length > 0, "the test printed a JSON report with metrics", JSON.stringify(report ?? {}).slice(0, 300));
  });

  await cases.testBroken.run(async () => {
    const case_ = cases.testBroken;
    const broken = await teamRepo({ "submission.py": BROKEN_SUBMISSION_PY });
    try {
      const test = home.start(["test", "--benchmark", BENCHMARK, "--json"], { cwd: broken.path });
      const exit = await finish(case_, "cogworks test --json (enroll raises)", test, 600_000);
      case_.expect(exit === 0 || exit === 2, "a raising adapter ends in a scored result or a categorized failure, never a crash", `exit ${exit}`);
      case_.expect(!TRACEBACK.test(test.output()), "no Python traceback reaches the terminal", test.output().slice(-400));
      case_.expect(test.output().includes(BROKEN_MARK), "the student's own error message reaches them", test.output().slice(-400));
    } finally {
      await broken.dispose();
    }
  });

  await cases.run.run(async () => {
    const case_ = cases.run;
    const before = await savedReports(repo.path);
    const runProcess = home.start(["run", "--benchmark", BENCHMARK, "--json"], { cwd: repo.path });
    const exit = await finish(case_, `cogworks run --benchmark ${BENCHMARK} --json`, runProcess, 900_000);
    case_.expect(exit === 0, "the practice run completed", `exit ${exit}; ${runProcess.output().slice(-300)}`);
    // Report names are random, and `test` saved one here too, so the run's
    // report is the file the run added, not the last name in sort order.
    const added = (await savedReports(repo.path)).filter((name) => !before.includes(name));
    case_.expect(added.length === 1, "the run saved one new report", `new files: ${JSON.stringify(added)}`);
    reportId = await reportIdOf(repo.path, added[0]);
    const report = home.start(["report"], { cwd: repo.path });
    const reportExit = await finish(case_, "cogworks report (latest)", report, 60_000);
    case_.expect(
      reportExit === 0 && reportId !== "" && report.output().includes(BENCHMARK),
      "cogworks report shows the saved report",
      `exit ${reportExit}; reportId ${reportId}; ${report.output().slice(0, 300)}`,
    );
  });

  await cases.runInterrupted.run(async () => {
    const case_ = cases.runInterrupted;
    const hanging = await teamRepo({ "submission.py": HANGING_SUBMISSION_PY });
    try {
      const runProcess = home.start(["run", "--benchmark", BENCHMARK], { cwd: hanging.path, group: true });
      // Long enough for the scoring child to be inside the hanging enroll;
      // the case asserts the outcome, not the timing.
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const interruptedAt = Date.now();
      runProcess.interrupt();
      const exit = await finish(case_, "cogworks run, Ctrl-C 20 s into a run whose enroll hangs", runProcess, 60_000);
      const seconds = (Date.now() - interruptedAt) / 1000;
      case_.expect(exit === 130 && /interrupted/.test(runProcess.output()), "Ctrl-C ends the run with exit 130 and says it was interrupted", `exit ${exit} after ${seconds.toFixed(1)} s; ${runProcess.output().slice(-300)}`);
      case_.expect(!TRACEBACK.test(runProcess.output()), "no Python traceback reaches the terminal", runProcess.output().slice(-300));
      case_.expect((await savedReports(hanging.path)).length === 0, "an interrupted run saves no report", "no report under .cogbench/reports");
    } finally {
      await hanging.dispose();
    }
  });

  await cases.reportAdversarial.run(async () => {
    const case_ = cases.reportAdversarial;
    const empty = await teamRepo();
    try {
      const none = home.start(["report"], { cwd: empty.path });
      const noneExit = await finish(case_, "cogworks report (no saved reports)", none, 60_000);
      case_.expect(
        noneExit === 2 && none.output().includes("No local reports found. Run `cogworks run` first."),
        "with no saved report, report exits 2 and names the next command",
        none.output().slice(-300),
      );
      const corrupt = join(empty.path, "corrupt-report.json");
      await writeFile(corrupt, "{}");
      const bad = home.start(["report", corrupt], { cwd: empty.path });
      const badExit = await finish(case_, "cogworks report <corrupt file>", bad, 60_000);
      case_.expect(
        badExit === 2 && bad.output().includes("Invalid saved report") && !TRACEBACK.test(bad.output()),
        "a corrupt report file exits 2 with a reason and the fix, not a traceback",
        bad.output().slice(-300),
      );
    } finally {
      await empty.dispose();
    }
  });

  await cases.unlinked.run(async () => {
    const case_ = cases.unlinked;
    const fresh = await CliHome.create(VENV_BIN);
    try {
      const status = fresh.start(["status"]);
      const statusExit = await finish(case_, "cogworks status (never linked)", status, 60_000);
      case_.expect(statusExit === 2 && status.output().includes("This portal is not linked. Run `cogworks link` first."), "status on an unlinked machine says to link", status.output().slice(-300));
      const sync = fresh.start(["sync"], { cwd: repo.path });
      const syncExit = await finish(case_, "cogworks sync (never linked)", sync, 60_000);
      case_.expect(syncExit === 2 && sync.output().includes("This portal is not linked. Run `cogworks link` first."), "sync on an unlinked machine says to link", sync.output().slice(-300));
    } finally {
      await fresh.close();
    }
  });

  await cases.link.run(async () => {
    const case_ = cases.link;
    await shape("fail_5xx", 1);
    try {
      const refused = home.start(["link", "--portal", info.shaperPortalOrigin, "--no-browser"]);
      const refusedExit = await finish(case_, "cogworks link (the start request answers 503)", refused, 60_000);
      case_.expect(
        refusedExit === 2 && refused.output().includes("CogPortal returned HTTP 503.") && !TRACEBACK.test(refused.output()),
        "a 503 at the start request exits 2 and names the portal's answer",
        refused.output().slice(-300),
      );
    } finally {
      await shape("normal");
    }
    await linkThroughBrowser(case_, home, {
      portalOrigin: info.shaperPortalOrigin,
      browsableOrigin: info.browsableOrigin,
      deviceName: `journey-${LABEL}`,
    });
    linked = true;
  });

  await cases.status.run(async () => {
    const case_ = cases.status;
    if (!linked) case_.blocked("the link case did not link this HOME");
    const status = home.start(["status"]);
    const exit = await finish(case_, "cogworks status (linked)", status, 60_000);
    case_.expect(exit === 0 && status.output().includes(`Device   journey-${LABEL}`), "status names the linked device", status.output().slice(0, 400));
    // request_json tries three times; three dropped connections exhaust it.
    await shape("drop", 3);
    try {
      const dropped = home.start(["status"]);
      const droppedExit = await finish(case_, "cogworks status (three connections dropped)", dropped, 60_000);
      case_.expect(
        droppedExit === 2 && dropped.output().includes("Could not reach CogPortal") && !TRACEBACK.test(dropped.output()),
        "with the portal unreachable, status exits 2 and says it could not reach CogPortal",
        dropped.output().slice(-300),
      );
    } finally {
      await shape("normal");
    }
    await shape("drop", 1);
    try {
      const once = home.start(["status"]);
      const onceExit = await finish(case_, "cogworks status (one connection dropped)", once, 60_000);
      case_.expect(onceExit === 0, "one dropped connection is retried and status succeeds", once.output().slice(-300));
    } finally {
      await shape("normal");
    }
  });

  await cases.sync.run(async () => {
    const case_ = cases.sync;
    if (!linked || reportId === "") case_.blocked("needs the linked HOME and the saved report from earlier cases");
    await shape("drop", 3);
    try {
      const dropped = home.start(["sync"], { cwd: repo.path });
      const droppedExit = await finish(case_, "cogworks sync (three connections dropped)", dropped, 120_000);
      case_.expect(
        droppedExit === 2 && dropped.output().includes("Could not reach CogPortal") && !TRACEBACK.test(dropped.output()),
        "with the portal unreachable, sync exits 2 and says it could not reach CogPortal",
        dropped.output().slice(-300),
      );
    } finally {
      await shape("normal");
    }
    case_.expect((await savedReports(repo.path)).length > 0, "the report is still saved locally after the failed sync", repo.path);
    const recovered = home.start(["sync"], { cwd: repo.path });
    const recoveredExit = await finish(case_, "cogworks sync (portal reachable again)", recovered, 120_000);
    case_.expect(recoveredExit === 0 && recovered.output().includes(`Synced ${reportId}`), "sync succeeds once the portal is reachable", recovered.output().slice(-300));
    const listed = [...(await portal.teamLocalReports(BENCHMARK)), ...(await portal.teamUntrackedReports())];
    case_.expect(listed.some((row: any) => (row.id ?? row.reportId) === reportId), "the portal lists the synced report for the team", `${listed.length} report(s); looking for ${reportId}`);
  });

  await cases.live.run(async () => {
    const case_ = cases.live;
    if (!linked) case_.blocked("the link case did not link this HOME");
    const live = home.start(["run", "--benchmark", BENCHMARK, "--live", "--json"], { cwd: repo.path });
    const exit = await finish(case_, "cogworks run --live --json (inactive benchmark)", live, 900_000);
    case_.expect(
      exit === 2 && /not active/i.test(live.output()) && !TRACEBACK.test(live.output()),
      "the portal refuses the inactive benchmark's live run by name and the CLI exits 2",
      live.output().slice(-300),
    );
  });
} finally {
  await shape("normal").catch(() => undefined);
  await home.close();
  await repo.dispose();
}
