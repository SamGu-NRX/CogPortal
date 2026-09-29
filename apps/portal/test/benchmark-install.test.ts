import assert from "node:assert/strict";
import { test } from "node:test";
import { setupCommandLines } from "../src/lib/setup-progress.ts";

// Accepted release sources, including the Vision fork rather than its upstream.
const sources = [
  ["audio-identification", "cogworks-week1-audio-benchmark", "839dd06bc2a14d2b1fa2202f9dc107ff5789c75a"],
  ["vision-recognition", "cogworks-week2-vision-benchmark", "4351ee9f237d85c6eb7d66b355bcfbc54f89bf14"],
  ["vision-clustering", "cogworks-week2-vision-benchmark", "4351ee9f237d85c6eb7d66b355bcfbc54f89bf14"],
  ["language-search", "cogworks-week3-language-benchmark", "f5f7347bbe16f179156e05e996deb356050b47be"],
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

for (const [track, distribution, revision] of sources) {
  test(`${track} resolves dependencies before replacing the accepted benchmark only`, () => {
    const reference = `"${distribution} @ git+https://github.com/SamGu-NRX/${distribution}.git@${revision}"`;
    const installs = commands(track).filter((line) => line.id === "benchmark");
    assert.equal(installs.length, 1);
    assert.equal(
      installs[0].command,
      `python -m pip install ${reference} && python -m pip install --force-reinstall --no-deps ${reference}`,
    );
  });
}

test("benchmark correction preserves the accepted SDK pin", () => {
  assert.equal(
    commands("language-search").find((line) => line.id === "tool")?.command,
    'python -m pip install --upgrade --force-reinstall "cogworks-benchmark @ git+https://github.com/SamGu-NRX/CogPortal.git@d9405278aac8268cd340e589f36dbad766d1e2a0#subdirectory=python/cogbench"',
  );
});

test("an unknown track does not invent a benchmark installation", () => {
  assert.equal(commands("unknown").some((line) => line.id === "benchmark"), false);
});
