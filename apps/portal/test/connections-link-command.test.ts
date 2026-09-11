import assert from "node:assert/strict";
import { test } from "node:test";

import { linkCommand, setupCommandLines } from "../src/lib/setup-progress.ts";

/**
 * The command Connections hands a first-time student.
 *
 * The device panel used to say "Run `cogworks link`". A CLI that has never been
 * linked has no saved portal, so it refuses that outright and tells the student
 * to copy `cogworks link --portal ...` from the setup page: the page sent them
 * to the terminal, and the terminal sent them back to find a different page.
 * `python/cogbench/src/cogbench/cli.py:129-134` is the refusal.
 */

const ORIGIN = "https://cogportal-dev.sillion.app";

test("the command names a portal, so an unconfigured CLI can run it", () => {
  const command = linkCommand(ORIGIN);

  assert.match(command, /--portal /, "a CLI with no saved portal refuses this");
  assert.ok(command.includes(ORIGIN), "the device request has to reach this portal");
});

test("Setup's rail and Connections show the same command", () => {
  // Two places offering different commands is how the student ends up linked to
  // the wrong portal, so they read from one function rather than two templates.
  const rail = setupCommandLines({
    cloneUrl: "https://github.com/cogworks-demo/face-finder.git",
    repoName: "face-finder",
    benchmarkId: "audio-identification",
    benchmarkTitle: "Audio",
    portalOrigin: ORIGIN,
    verified: () => false,
    deviceLinked: false,
  }).find((line) => line.id === "link");

  assert.ok(rail, "the setup rail still has a link step");
  assert.equal(rail.command, linkCommand(ORIGIN));
});

test("a local origin is carried through unchanged", () => {
  // The CLI accepts localhost explicitly, and development is the only place the
  // origin is not the deployed one.
  assert.equal(linkCommand("http://localhost:5173"), "cogworks link --portal http://localhost:5173");
});
