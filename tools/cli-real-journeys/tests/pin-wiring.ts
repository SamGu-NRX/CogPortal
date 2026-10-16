/**
 * The pin-wiring contract (review block: "true portal-revision pins"),
 * demonstrated against real installs.
 *
 * The beta and alpha labels must install the COGBENCH_SOURCE that each
 * label's PORTAL REVISION declares — read from that revision's tip
 * (origin/beta, origin/alpha), never from a CLI commit reused as a revision.
 * The old wiring read the file at the CLI commits themselves, which resolved
 * the beta label to an older CLI commit (71e4767) and the alpha label to
 * 064400e9, so alpha's real pin (ecae6171…) was never installed.
 *
 * Three real checks, each with its evidence printed:
 *   A. Wiring: reading the file at the old revisions' commits still resolves
 *      each label away from the branch's own pin — the defect, shown live.
 *   B. Red: installing what the OLD wiring's beta label names (a real pip
 *      install into a scratch venv) must FAIL the installed-commit assertion
 *      when it is judged against the beta revision's file.
 *   C. Green: installing what the CORRECTED wiring names must PASS that same
 *      assertion, with direct_url.json recording the branch's exact commit.
 *
 * Run: npx tsx tests/pin-wiring.ts  (network: two GitHub pip installs)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installedMatchesPin, pinnedSource, readDirectUrl } from "../support/installed-commit.ts";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const OLD_WIRING_REVISIONS: Array<[string, string]> = [
  ["beta", "064400e9cf65874b87fe888fc6fd14a564095c5e"],
  ["alpha", "ecae6171521d59cc3e66a737df154c7e2c2bb5d1"],
];

let failures = 0;
function check(label: string, ok: boolean, evidence: string): void {
  const mark = ok ? "ok" : "FAIL";
  console.log(`[${mark}] ${label} — ${evidence}`);
  if (!ok) failures += 1;
}

async function pipInstall(python: string, spec: string): Promise<void> {
  await run(python, ["-m", "pip", "install", "--quiet", "--force-reinstall", spec], {
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function main(): Promise<void> {
  // A. The wiring itself: each label's portal revision names its own CLI
  // commit, and the old revisions' commits do NOT name the same one. Read
  // live from git, so the test breaks the moment the wiring regresses.
  const betaPin = await pinnedSource(REPO_ROOT, "origin/beta");
  const alphaPin = await pinnedSource(REPO_ROOT, "origin/alpha");
  check(
    "the beta revision's file pins a CLI commit",
    /^git\+https:\/\/github\.com\/SamGu-NRX\/CogPortal\.git@[0-9a-f]{40}#subdirectory=python\/cogbench$/.test(betaPin),
    betaPin,
  );
  check(
    "the alpha revision's file pins a CLI commit",
    /^git\+https:\/\/github\.com\/SamGu-NRX\/CogPortal\.git@[0-9a-f]{40}#subdirectory=python\/cogbench$/.test(alphaPin),
    alphaPin,
  );
  for (const [label, oldRev] of OLD_WIRING_REVISIONS) {
    const branchPin = label === "beta" ? betaPin : alphaPin;
    const oldPin = await pinnedSource(REPO_ROOT, oldRev);
    check(
      `the old wiring's ${label} label (file read at ${oldRev.slice(0, 10)}) does not resolve to ${label}'s own pin`,
      oldPin !== branchPin,
      `old wiring resolved ${oldPin}; the ${label} revision pins ${branchPin}`,
    );
  }

  // B/C. The installed-commit assertion, red then green, on real installs.
  const scratch = await mkdtemp(join(tmpdir(), "pin-wiring-"));
  const venvDir = join(scratch, "venv");
  try {
    await run("python3", ["-m", "venv", venvDir]);
    const python = join(venvDir, "bin", "python");

    // Red: the old wiring's beta label installs an older CLI commit; judged
    // against the beta revision's file, the assertion must fail.
    const oldBetaPin = await pinnedSource(REPO_ROOT, OLD_WIRING_REVISIONS[0][1]);
    await pipInstall(python, `cogworks-benchmark @ ${oldBetaPin}`);
    const wrongInstall = await readDirectUrl(python, "cogworks_benchmark");
    const wrongVerdict = installedMatchesPin(wrongInstall, betaPin);
    check(
      "the old wiring's install FAILS the installed-commit assertion against the beta revision",
      !wrongVerdict.ok,
      `installed commit ${wrongVerdict.installedCommit.slice(0, 10)} (url ${wrongVerdict.installedUrl}); the beta revision pins ${wrongVerdict.pinCommit.slice(0, 10)}`,
    );
    check(
      "the old wiring's install is what its (wrong) source named — the assertion, not pip, caught the drift",
      wrongVerdict.installedCommit !== "" && wrongVerdict.installedCommit === (oldBetaPin.match(/@([0-9a-f]{40})/)?.[1] ?? ""),
      `direct_url commit ${wrongVerdict.installedCommit.slice(0, 10)} == old source's pin`,
    );

    // Green: the corrected wiring installs the beta revision's own pin; the
    // same assertion must pass, with the commit pip recorded matching it.
    await pipInstall(python, `cogworks-benchmark @ ${betaPin}`);
    const rightInstall = await readDirectUrl(python, "cogworks_benchmark");
    const rightVerdict = installedMatchesPin(rightInstall, betaPin);
    check(
      "the corrected wiring's install PASSES the installed-commit assertion against the beta revision",
      rightVerdict.ok,
      `direct_url.json records commit ${rightVerdict.installedCommit.slice(0, 10)} == the beta revision's pin ${rightVerdict.pinCommit.slice(0, 10)}`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`pin-wiring: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("pin-wiring: all checks passed");
}

await main();
