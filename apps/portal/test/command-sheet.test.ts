import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SetupStep } from "@cogworks/contracts/schema";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { CommandSheet, commandText } from "../src/components/CommandSheet.tsx";
import { BENCHMARK_PACKAGES, benchmarkPackage } from "../src/lib/benchmark-packages.ts";
import { setupCommandLines } from "../src/lib/setup-progress.ts";

/**
 * The setup page is now a sheet of commands a student pastes literally, so
 * the strings are the product. These pin the three things that are wrong in a
 * way no type checks: an install that resolves to the wrong artifact, a check
 * that silently reports nothing, and a gutter that claims a fact the portal
 * has not observed.
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
  assert.equal(unknown.filter((line) => line.comment.startsWith("# benchmark for")).length, 0);
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
  assert.equal(sheet.filter((line) => line.comment.includes("registers:")).length, 0);

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

test("copy all carries the commands and none of the comments", () => {
  const sheet = lines();
  const text = commandText(sheet);

  assert.doesNotMatch(text, /^#/m);
  assert.equal(text.split("\n").length, sheet.length);
  assert.equal(text.split("\n")[0], sheet[0]!.command);
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

test("the rendered sheet moves a tick only for the lines it has verified", () => {
  const html = renderToStaticMarkup(
    React.createElement(CommandSheet, {
      lines: lines({}, ["clone"]),
      label: "Setup commands, in run order",
    }),
  );

  // anim-rise is the tick's entrance; one verified line means one tick.
  assert.equal(html.match(/anim-rise/g)?.length, 1);
  assert.equal(html.match(/Verified\. /g)?.length, 1);
  assert.equal(
    html.match(/Not verified yet\. /g)?.length,
    lines().length - 1,
  );
  // Every line keeps a gutter cell, filled or empty.
  assert.equal(
    (html.match(/bg-verify-wash/g)?.length ?? 0) +
      (html.match(/bg-paper-raised/g)?.length ?? 0),
    lines().length,
  );
});

test("the sheet's own text uses no em dash", () => {
  const html = renderToStaticMarkup(
    React.createElement(CommandSheet, {
      lines: lines({}, ["clone", "environment"]),
      label: "Setup commands, in run order",
    }),
  );
  assert.ok(!html.includes("—"), "em dash rendered on the command sheet");
});
