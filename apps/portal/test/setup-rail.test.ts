import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SetupStep } from "@cogworks/contracts/schema";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { StaticRouter } from "react-router";
import { Step, StepRail } from "../src/components/StepRail.tsx";
import {
  BENCHMARK_PACKAGES,
  benchmarkEnvironment,
  benchmarkPackage,
} from "../src/lib/benchmark-packages.ts";
import { setupCommandLines, stepState } from "../src/lib/setup-progress.ts";

/**
 * The setup page is a numbered rail of commands a student pastes literally,
 * so the strings are the product. These pin the things that are wrong in a way
 * no type checks: an install that resolves to the wrong artifact, a check that
 * silently reports nothing, and a step that claims a fact the portal has not
 * observed.
 */

function lines(
  overrides: Partial<Parameters<typeof setupCommandLines>[0]> = {},
  verified: readonly SetupStep[] = [],
) {
  const seen = new Set<SetupStep>(verified);
  return setupCommandLines({
    cloneUrl: "https://github.com/demo-org/rooks-nest.git",
    repoName: "rooks-nest",
    benchmarkId: "vision-recognition",
    benchmarkTitle: "Recognition",
    portalOrigin: "https://cogportal.example",
    verified: (step) => seen.has(step),
    deviceLinked: false,
    ...overrides,
  });
}



function commandFor(fragment: string): string {
  const found = lines().find((line) => line.command.includes(fragment));
  assert.ok(found, `no command containing ${fragment}`);
  return found.command;
}
test("the tool is installed from a commit, like every other package here", () => {
  // Neither TestPyPI nor main serves a usable tool: both hold cogbench 0.1.0,
  // and main is 112 commits back with no resolve.py, so `check` there cannot
  // search a student's repository.
  //
  // This line used to name a branch, and the branch it named fell 22 commits
  // behind the reviewed CLI, so the setup page demonstrated a tool without any
  // of the accepted corrections. A commit also means two people on this page
  // install the same thing.
  const tool = commandFor("cogworks-benchmark");

  assert.match(
    tool,
    /git\+https:\/\/github\.com\/SamGu-NRX\/CogPortal\.git@[0-9a-f]{40}#subdirectory=python\/cogbench/,
  );
  assert.doesNotMatch(tool, /CogPortal\.git@main/);
  assert.doesNotMatch(tool, /test\.pypi\.org/);
  // --force-reinstall, not just --upgrade. The version stays 0.2.0 across
  // pins, so pip treats an equal version as already satisfied: measured, an
  // --upgrade between two pins exited zero and left the older commit
  // installed. Asserted because dropping it would still pass an --upgrade
  // check while quietly stranding every returning student.
  assert.match(tool, /--force-reinstall/);
});

test("only the tool is force-reinstalled, never a benchmark", () => {
  // The tool declares no dependencies, so forcing it reinstalls nothing else.
  // A benchmark brings the course stack (librosa, numba, numpy), and forcing
  // one of those would rebuild an environment the student spent an afternoon
  // installing.
  const forced = lines().filter((line) => line.command.includes("--force-reinstall"));

  assert.equal(forced.length, 1, "exactly one command may force a reinstall");
  assert.match(forced[0].command, /cogworks-benchmark @/);
});

test("the check that claims to update this page carries the flag that does it", () => {
  // cli.py only POSTs setup evidence when args.update_setup is set; without
  // the flag it returns after the local check and the gutter never fills.
  const check = commandFor("cogworks check");

  assert.match(check, /--benchmark vision-recognition\b/);
  assert.match(check, /--update-setup/);
});

test("every benchmark package is pinned to a commit rather than a branch", () => {
  // A branch reference makes two runs of the same pasted command install
  // different code, which is invisible until a score moves.
  for (const [id, pkg] of Object.entries(BENCHMARK_PACKAGES)) {
    assert.match(pkg.source, /^git\+https:\/\/\S+\.git@[0-9a-f]{40}$/, id);
    assert.ok(pkg.distribution.length > 0, id);
  }
});

test("the two vision tracks install one distribution", () => {
  // Switching between recognition and clustering must not ask for a reinstall.
  assert.equal(
    benchmarkPackage("vision-recognition")?.source,
    benchmarkPackage("vision-clustering")?.source,
  );
  assert.equal(
    benchmarkPackage("vision-recognition")?.distribution,
    "cogworks-week2-vision-benchmark",
  );
});

test("a track with no published package shows no install line rather than a guess", () => {
  const unknown = lines({ benchmarkId: "not-a-track" });
  assert.equal(unknown.filter((line) => line.id === "benchmark").length, 0);
  assert.equal(unknown.length, lines().length - 1);
  // The CLI itself is still installed; only the benchmark line is withheld.
  assert.ok(unknown.some((line) => line.command.includes("cogworks-benchmark")));
});

test("the sheet never asks for an editable install", () => {
  // The template and every fork carry no pyproject.toml or setup.py, so
  // `pip install -e .` failed for every student who reached it. The resolver
  // reads the repository directly and registers nothing.
  const sheet = lines();
  assert.equal(sheet.length, 5);
  assert.equal(sheet.filter((line) => line.command.includes("install -e")).length, 0);
  assert.equal(sheet.filter((line) => line.command.includes("install -e")).length, 0);

  // The project evidence did not go with it; it now rides the benchmark line.
  const project = lines({}, ["project"]).filter((line) => line.verified);
  assert.equal(project.length, 1);
  assert.match(project[0]!.command, /^python -m pip install "cogworks-week2/);
});

test("the clone command names the team's own repository", () => {
  assert.equal(
    commandFor("git clone"),
    "git clone https://github.com/demo-org/rooks-nest.git && cd rooks-nest",
  );
});
test("a gutter cell fills only for a step the portal has observed", () => {
  const none = lines();
  assert.equal(none.filter((line) => line.verified).length, 0);

  // One check reports clone, environment, project and wiring together, so the
  // sheet fills every cell but the optional device link.
  const checked = lines({}, ["clone", "environment", "project", "wiring"]);
  assert.equal(checked.length, 5);
  const unfilled = checked.filter((line) => !line.verified);
  assert.equal(unfilled.length, 1);
  assert.match(unfilled[0]!.command, /^cogworks link/);

  const linked = lines({ deviceLinked: true }, ["clone", "environment", "project", "wiring"]);
  assert.equal(linked.filter((line) => !line.verified).length, 0);
});

/**
 * One rail, assembled the way the page assembles it.
 *
 * The state comes from the production `stepState`, not from a copy of its rule
 * here: a test that reimplemented the per-read selection would stay green if
 * the page started blanking every step on any outage.
 */
const TITLES: Record<string, string> = {
  clone: "Get the code",
  tool: "Set up your environment",
  benchmark: "Install the Recognition benchmark",
  link: "Link this device",
  check: "Prove the wiring",
};

function railHtml(
  options: {
    verified?: readonly SetupStep[];
    deviceLinked?: boolean;
    unreadable?: Partial<Record<"setup-state" | "devices", boolean>>;
  } = {},
): string {
  const rail = lines({ deviceLinked: options.deviceLinked ?? false }, options.verified ?? []);
  return renderToStaticMarkup(
    React.createElement(
      StaticRouter as never,
      { location: "/setup" },
      React.createElement(
        StepRail,
        null,
        rail.map((line, index) =>
          React.createElement(
            Step,
            {
              key: line.id,
              index: String(index + 1).padStart(2, "0"),
              state: stepState(line, options.unreadable ?? {}),
              title: TITLES[line.id]!,
              last: index === rail.length - 1,
            },
            React.createElement("code", null, line.command),
          ),
        ),
      ),
    ),
  );
}

test("the rail ticks only the steps it has verified", () => {
  const html = railHtml({ verified: ["clone"] });

  // anim-rise is the chip's entrance; one verified step means one chip.
  assert.equal(html.match(/anim-rise/g)?.length, 1);
  assert.equal(html.match(/Verified\. /g)?.length, 1);
  assert.equal(html.match(/Not verified yet\. /g)?.length, lines().length - 1);
});

test("every step renders its own heading, its own mark and its own command", () => {
  const html = railHtml();
  // React escapes quotes in the pinned install lines, so compare like for like.
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

  for (const line of lines()) {
    assert.ok(html.includes(escape(line.command)), `no command rendered for ${line.id}`);
    assert.ok(html.includes(TITLES[line.id]!), `no heading rendered for ${line.id}`);
  }
  assert.equal(html.match(/<h2/g)?.length, lines().length);
  // Every unverified step still shows its ordinal, so a rail of five reads as
  // five things to do rather than as blank squares.
  for (const ordinal of ["01", "02", "03", "04", "05"]) {
    assert.ok(html.includes(`>${ordinal}</span>`), `no mark rendered for step ${ordinal}`);
  }
});

test("the rail's own text uses no em dash", () => {
  assert.ok(!railHtml({ verified: ["clone", "environment"] }).includes("\u2014"));
});

test("an unreadable evidence request is not rendered as work nobody did", () => {
  // The setup queries fall back to an empty verified set, which is exactly
  // what a student who has run nothing produces. Rendered as empty boxes, an
  // outage tells someone their finished setup was never seen and sends them
  // back to a terminal where everything already worked.
  const html = railHtml({
    deviceLinked: true,
    verified: ["clone", "environment", "project", "wiring"],
    unreadable: { "setup-state": true, devices: true },
  });

  assert.ok(html.includes("Progress unknown. "), "no unknown state announced");
  assert.ok(!html.includes("Verified. "), "claimed verification it could not read");
  assert.ok(!html.includes("Not verified yet. "), "claimed the work was not done");
});

test("a read that succeeded still ticks", () => {
  const html = railHtml({
    deviceLinked: true,
    verified: ["clone", "environment", "project", "wiring"],
  });

  assert.equal(html.match(/Verified\. /g)?.length, lines().length);
  assert.ok(!html.includes("Progress unknown. "), "an observed read claimed to be unknown");
});

test("one failed read does not blank the steps the other read answered", () => {
  // The device list and the setup state are separate requests, so an outage in
  // one must not withhold facts the other answered correctly.
  const done = lines(
    { deviceLinked: true },
    ["clone", "environment", "project", "wiring"],
  );

  const devicesDown = done.map((line) => stepState(line, { devices: true }));
  assert.deepEqual(
    devicesDown,
    ["verified", "verified", "verified", "unknown", "verified"],
    "only the link step reads the device list",
  );

  const stateDown = done.map((line) => stepState(line, { "setup-state": true }));
  assert.deepEqual(
    stateDown,
    ["unknown", "unknown", "unknown", "verified", "unknown"],
    "the link step does not read the setup state",
  );

  const html = railHtml({
    deviceLinked: true,
    verified: ["clone", "environment", "project", "wiring"],
    unreadable: { devices: true },
  });
  assert.equal(html.match(/Verified\. /g)?.length, 4, "the setup state's four steps were lost");
  assert.equal(html.match(/Progress unknown\. /g)?.length, 1, "only the link step is unknown");
});
