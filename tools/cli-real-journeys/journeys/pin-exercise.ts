import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CliHome, env } from "../support/cli.ts";
import { installedMatchesPin, readDirectUrl } from "../support/installed-commit.ts";
import { TeamRepository } from "../support/git-fixture.ts";
import { readStackInfo } from "../support/stack-info.ts";
import { Case } from "./harness.ts";
import { SUBMISSION_PY } from "./submission.ts";

/**
 * One entry of the pin matrix: the documented staging pin (the COGBENCH_SOURCE
 * a staging environment's copy of benchmark-packages.ts names) installed into
 * one course environment on its real Python, then exercised — the CLI reports
 * its version, the installed distribution carries the pin in its direct_url
 * record, and, where this environment holds the week 1 benchmark, a real
 * scored small case runs under the pinned CLI.
 *
 * run-all.sh does the installs and exports PIN_ID/PIN_REV/PIN_SOURCE plus
 * VENV_MATRIX; the receipts carry the pin, so every matrix cell says which
 * staging pin and which Python it ran.
 */
const run = promisify(execFile);
const PIN_ID = env("PIN_ID");
const PIN_REV = env("PIN_REV");
const PIN_SOURCE = env("PIN_SOURCE");
const VENV_BIN = env("VENV_MATRIX");
const python = join(VENV_BIN, "python");

// Every process this journey spawns is pinned to the booted local stack's
// loopback origin, overriding any inherited COGPORTAL_URL (readStackInfo has
// already refused a non-loopback one). The small case's `cogworks test` gets
// the same pin through CliHome.
const PINNED_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  COGPORTAL_URL: (await readStackInfo()).shaperPortalOrigin,
};

function pinLabel(suffix: string): string {
  return `${suffix}-${PIN_ID}-${process.env.PIN_ENV ?? "env"}`;
}

const cases = {
  install: new Case("pin-exercise", pinLabel("install"), ["installed CLI"]),
  smallCase: new Case("pin-exercise", pinLabel("small-case"), ["installed CLI", "benchmark package", "team repo"]),
};

await cases.install.run(async () => {
  const case_ = cases.install;
  const status = env("PIN_INSTALL_STATUS");
  if (status === "missing") {
    case_.blocked(`conda environment for this matrix cell is absent on this machine (pin ${PIN_ID})`);
  }
  if (status === "failed") {
    const log = await readFile(env("PIN_INSTALL_LOG"), "utf8").catch(() => "");
    case_.blocked(
      `pip could not install the pinned CLI for pin ${PIN_ID} — this combination is left out of the exercised matrix. Log tail: ${log.slice(-800)}`,
    );
  }
  const version = await run(python, ["-c", "print(__import__('sys').version.split()[0])"], { env: PINNED_ENV });
  const cogworks = await run(join(VENV_BIN, "cogworks"), ["--version"], { env: PINNED_ENV });
  case_.command(`cogworks --version (pin ${PIN_ID}, python ${version.stdout.trim()})`, 0, cogworks.stdout);
  case_.expect(
    cogworks.stdout.trim().length > 0,
    `the pinned CLI runs on python ${version.stdout.trim()}`,
    `--version printed: ${cogworks.stdout.trim().slice(0, 120)}`,
  );
  const installed = await readDirectUrl(python, "cogworks_benchmark", PINNED_ENV);
  // pip records a git install's commit under vcs_info, not in the url; the
  // pin's identity is the commit its portal revision's COGBENCH_SOURCE names,
  // so compare that — the installed-commit assertion holds only when the
  // environment got exactly what the revision's file declares.
  const verified = installedMatchesPin(installed, PIN_SOURCE);
  case_.expect(
    verified.ok,
    `the installed cogworks-benchmark is the pin ${PIN_ID} source (CLI commit ${verified.pinCommit.slice(0, 10)})`,
    `direct_url.json: ${JSON.stringify(installed)}; pin source: ${PIN_SOURCE}`,
  );
  case_.claim("the source the pin resolves to", PIN_SOURCE);
});

await cases.smallCase.run(async () => {
  const case_ = cases.smallCase;
  const benchmark = process.env.PIN_TEST_BENCHMARK ?? "";
  if (!benchmark) {
    // Version-matrix cells (py311, py313) hold no course benchmark by
    // design — their exercise is the install-and-run case above.
    return;
  }
  const home = await CliHome.create(VENV_BIN);
  const repo = await TeamRepository.create({
    originFullName: "cogworks-demo/face-finder",
    files: { "submission.py": SUBMISSION_PY },
  });
  try {
    const test = home.start(["test", "--benchmark", benchmark, "--json"], { cwd: repo.path });
    const exit = await test.exited(600_000);
    case_.command(`cogworks test --benchmark ${benchmark} --json (pin ${PIN_ID})`, exit, test.output());
    if (/not installed|ImportError|ModuleNotFoundError/.test(test.output()) && exit !== 0) {
      case_.blocked(`pin ${PIN_ID} environment missing a course dependency; CLI output ends: ${test.output().slice(-600)}`);
    }
    case_.expect(exit === 0, `the pinned CLI (pin ${PIN_ID}) scored the week 1 small case`, `cogworks test exited ${exit}`);
    const reportsDir = join(repo.path, ".cogbench", "reports");
    const reports = (await readdir(reportsDir).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort();
    for (const name of reports) {
      const report = JSON.parse(await readFile(join(reportsDir, name), "utf8"));
      case_.claim(
        "the scored report the pinned CLI saved",
        `benchmark=${report.benchmarkId} metrics=${(report.metrics ?? []).map((metric: any) => metric.key).join(",")}`,
      );
    }
  } finally {
    await home.close();
    await repo.dispose();
  }
});
