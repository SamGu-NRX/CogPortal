import assert from "node:assert/strict";
import { test } from "node:test";
import { setupCommandLines } from "../src/lib/setup-progress.ts";

// Accepted release sources, including the Vision fork rather than its upstream.
// The fourth field is the extras the first, dependency-resolving install
// asks for: Vision's check reads real faces through `datasets`.
const sources = [
  ["audio-identification", "cogworks-week1-audio-benchmark", "4e516f39ffbeefe579e093260b2865eb354c17a7", ""],
  ["vision-recognition", "cogworks-week2-vision-benchmark", "a3dd948d0c108fabf070b4f159acdecd4d6c3897", "[data]"],
  ["vision-clustering", "cogworks-week2-vision-benchmark", "a3dd948d0c108fabf070b4f159acdecd4d6c3897", "[data]"],
  ["language-search", "cogworks-week3-language-benchmark", "4b1755433110b387b8a37021ef173300636d3b8c", ""],
] as const;

function commands(benchmarkId: string) {
  return setupCommandLines({
    cloneUrl: "https://github.com/example/team.git",
    repoName: "team",
    benchmarkId,
    benchmarkTitle: benchmarkId,
    portalOrigin: "https://cogportal.example",
    verified: () => false,
    deviceLinked: false,
  });
}

for (const [track, distribution, revision, extras] of sources) {
  test(`${track} resolves dependencies before replacing the accepted benchmark only`, () => {
    const source = `git+https://github.com/SamGu-NRX/${distribution}.git@${revision}`;
    const installs = commands(track).filter((line) => line.id === "benchmark");
    assert.equal(installs.length, 1);
    assert.equal(
      installs[0].command,
      `python -m pip install "${distribution}${extras} @ ${source}" && python -m pip install --force-reinstall --no-deps "${distribution} @ ${source}"`,
    );
  });
}

test("benchmark correction preserves the accepted SDK pin", () => {
  assert.equal(
    commands("language-search").find((line) => line.id === "tool")?.command,
    'python -m pip install --upgrade --force-reinstall "cogworks-benchmark @ git+https://github.com/SamGu-NRX/CogPortal.git@ebb9f383bfc967cae22f0a0057fdd530a6f38229#subdirectory=python/cogbench"',
  );
});

test("an unknown track does not invent a benchmark installation", () => {
  assert.equal(commands("unknown").some((line) => line.id === "benchmark"), false);
});
