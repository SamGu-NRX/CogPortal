import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CliHome, env } from "../support/cli.ts";
import { TeamRepository } from "../support/git-fixture.ts";
import { Portal } from "../support/portal.ts";
import { readStackInfo } from "../support/stack-info.ts";
import { Case } from "./harness.ts";
import { SUBMISSION_PY } from "./submission.ts";

/**
 * The benchmark journey, entirely real: a team repository with a working
 * Week 1 submission, the installed CLI scoring it against the benchmark's
 * own synthetic corpus, the report it saves, the sync that posts it to the
 * portal, and the live progress bubble the run sends to the course Discord
 * (observed on the loopback double).
 *
 * The submission is written for this suite in the shape the benchmark's
 * discovery accepts — a factory class with enroll/identify — adapted from
 * the fingerprint-matching pattern the benchmark's own reference tests use.
 */
const info = await readStackInfo();
const portal = await Portal.create();
// Approvals run from the same dev session a browser would hold; without it
// every approveDevice call answers 401.
await portal.devLogin("journey-student", { demo: true });
const BENCHMARK = "audio-identification";

/** Links a fresh CLI HOME and approves it from the browser session. */
async function link(case_: Case, home: CliHome, deviceName: string): Promise<void> {
  const link = home.start(["link", "--portal", info.shaperPortalOrigin, "--no-browser"]);
  const printed = await link.waitFor(/user_code=([A-Za-z0-9-]+)/, 30_000);
  let approved = await portal.approveDevice(printed[1], deviceName);
  if (approved >= 500) {
    // One boot-settling retry: the first proxied request after the stack
    // comes up has once died with a 502 (socket hang up). The approve route
    // is idempotent for the same user, so a retry cannot double-approve.
    approved = await portal.approveDevice(printed[1], deviceName);
  }
  case_.expect(
    approved === 200,
    `the browser session approved device ${deviceName}`,
    `approve answered ${approved}`,
  );
  const exit = await link.exited(60_000);
  case_.expect(exit === 0, "the CLI linked", `cogworks link exited ${exit}; output: ${link.output().slice(-400)}`);
  case_.command("cogworks link --portal <shaper> --no-browser", exit, link.output());
}

/** The newest saved local report in the team repository, parsed. */
async function latestReport(repoPath: string): Promise<Record<string, any>> {
  const dir = join(repoPath, ".cogbench", "reports");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  if (names.length === 0) throw new Error(`no saved reports under ${dir}`);
  return JSON.parse(await readFile(join(dir, names[names.length - 1]), "utf8"));
}

/** The trailing JSON document in CLI output, parsed. The document may sit
 * after human-readable lines and contain nested objects, so scanning from
 * the last `{` (which is nested, not the document's start) fails; instead
 * try each `{` from the end and take the first suffix that parses whole. */
function trailingJson(text: string): any | null {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== "{") continue;
    try {
      return JSON.parse(text.slice(i));
    } catch {
      // keep scanning backwards
    }
  }
  return null;
}

const cases = {
  selfLink: new Case("benchmark-real-run", "self-link", ["portal Worker", "installed CLI"]),
  testSmall: new Case("benchmark-real-run", "test-small-case", ["installed CLI", "benchmark package", "team repo"]),
  runSync: new Case("benchmark-real-run", "run-and-sync", ["installed CLI", "benchmark package", "portal Worker", "D1"]),
  liveBubble: new Case("benchmark-real-run", "live-run-bubble", ["installed CLI", "portal Worker", "CogBot", "Discord double"]),
};

await cases.selfLink.run(async () => {
  const case_ = cases.selfLink;
  const home = await CliHome.create(env("VENV_WEEK1"));
  try {
    await link(case_, home, "journey-bench");
    const devices = await portal.cliDevices();
    case_.expect(
      devices.some((device) => device.name === "journey-bench"),
      "the portal lists the benchmark journey's device",
      JSON.stringify(devices.map((device) => device.name)),
    );
  } finally {
    await home.close();
  }
});

await cases.testSmall.run(async () => {
  const case_ = cases.testSmall;
  const home = await CliHome.create(env("VENV_WEEK1"));
  const repo = await TeamRepository.create({
    originFullName: "cogworks-demo/face-finder",
    files: { "submission.py": SUBMISSION_PY },
  });
  try {
    await link(case_, home, "journey-bench");
    const test = home.start(["test", "--benchmark", BENCHMARK, "--json"], { cwd: repo.path });
    const exit = await test.exited(600_000);
    case_.command("cogworks test --benchmark audio-identification --json", exit, test.output());
    if (/not installed|ImportError|ModuleNotFoundError/.test(test.output()) && exit !== 0) {
      case_.blocked(`course environment missing a real dependency; CLI output ends: ${test.output().slice(-600)}`);
    }
    case_.expect(exit === 0, "the small-case run scored the submission", `cogworks test exited ${exit}`);
    const parsed = trailingJson(test.output());
    if (parsed === null) {
      case_.blocked(`--json output was not parseable; tail: ${test.output().slice(-400)}`);
    }
    case_.expect(
      parsed && typeof parsed === "object",
      "the test command returned a JSON report",
      `keys: ${parsed ? Object.keys(parsed).join(",") : "none"}`,
    );
  } finally {
    await home.close();
    await repo.dispose();
  }
});

await cases.runSync.run(async () => {
  const case_ = cases.runSync;
  const home = await CliHome.create(env("VENV_WEEK1"));
  const repo = await TeamRepository.create({
    originFullName: "cogworks-demo/face-finder",
    files: { "submission.py": SUBMISSION_PY },
  });
  try {
    await link(case_, home, "journey-bench");
    const run = home.start(["run", "--benchmark", BENCHMARK, "--json"], { cwd: repo.path });
    const exit = await run.exited(900_000);
    case_.command("cogworks run --benchmark audio-identification --json", exit, run.output());
    case_.expect(exit === 0, "the practice run completed", `cogworks run exited ${exit}`);
    const report = await latestReport(repo.path);
    case_.expect(
      Boolean(report.id ?? report.reportId),
      "the run saved a local report with an id",
      `report keys: ${Object.keys(report).slice(0, 12).join(",")}`,
    );
    const head = await repo.head();
    case_.claim("the team repository's HEAD the run pinned", head);

    const sync = home.start(["sync"], { cwd: repo.path });
    const syncExit = await sync.exited(120_000);
    case_.command("cogworks sync", syncExit, sync.output());
    case_.expect(syncExit === 0, "the saved report synced to the portal", `cogworks sync exited ${syncExit}`);

    const reports = await portal.teamLocalReports(BENCHMARK);
    const found = reports.find((row: any) => (row.id ?? row.reportId) === (report.id ?? report.reportId));
    case_.expect(
      Boolean(found),
      "the synced report appears in the team's portal view for the benchmark",
      `${reports.length} report(s) listed; looking for ${report.id ?? report.reportId}`,
    );
  } finally {
    await home.close();
    await repo.dispose();
  }
});

await cases.liveBubble.run(async () => {
  const case_ = cases.liveBubble;
  const home = await CliHome.create(env("VENV_WEEK1"));
  const repo = await TeamRepository.create({
    originFullName: "cogworks-demo/face-finder",
    files: { "submission.py": SUBMISSION_PY },
  });
  try {
    await link(case_, home, "journey-bench");
    // audio-identification ships inactive (0020_week1_audio.sql holds
    // active=0 on purpose until a calibration ablation passes), so the live
    // bubble is refused by design. This case pins the refusal contract:
    // nonzero exit and the benchmark's state named, with no fabricated
    // success. A live-run happy path needs an active-benchmark fixture.
    const run = home.start(["run", "--benchmark", BENCHMARK, "--live", "--json"], { cwd: repo.path });
    const exit = await run.exited(900_000);
    case_.command("cogworks run --benchmark audio-identification --live --json (inactive benchmark)", exit, run.output());
    case_.expect(
      exit !== 0 && /not active/i.test(run.output()),
      "the live run was refused with the benchmark's inactive state named",
      `exited ${exit}; output ends: ${run.output().slice(-300)}`,
    );
  } finally {
    await home.close();
    await repo.dispose();
  }
});
