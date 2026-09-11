import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PreparedEnvironmentV1Schema } from "@cogworks/contracts/protocol";
import { savedEnvironmentEligibility } from "../worker/services/run-eligibility.ts";

const evidence = PreparedEnvironmentV1Schema.parse(JSON.parse(readFileSync(
  new URL("../../../protocols/v1/fixtures/prepared-environment.valid.json", import.meta.url), "utf8",
)));

function eligible(benchmarkId: string, pythonVersion: string, sandboxContract: number | null = 1) {
  return savedEnvironmentEligibility({
    preparedArtifactId: evidence.artifactId,
    preparedEnvironmentJson: JSON.stringify({ ...evidence, benchmarkId, pythonVersion }),
    benchmarkId,
    repositoryId: evidence.source.repositoryId,
    sha: evidence.source.sha,
  }, { id: benchmarkId, sandboxContract }, evidence.source.fullName);
}

test("Audio and Language match evaluation's Python requirement without requiring the build patch", () => {
  const modal = readFileSync(new URL("../../runner-modal/src/cogworks_runner/modal_app.py", import.meta.url), "utf8");
  const script = modal.split('EVALUATE_SCRIPT = r"""')[1].split('"""')[0];
  for (const week of [1, 3]) {
    assert.match(script, new RegExp(`if sys\\.version_info\\[:2\\] != \\(3, 8\\):\\s+raise RuntimeError\\(\\s+"Week ${week} evaluation must run under Python 3\\.8`));
  }
  assert.equal((modal.match(/assert sys\.version_info\[:3\] == \(3, 8, 20\)/g) ?? []).length, 2);
  for (const id of ["audio-identification", "language-search"]) {
    assert.equal(eligible(id, "3.8.20").eligible, true);
    assert.equal(eligible(id, "3.8.19").eligible, true);
    for (const python of ["3.8", "3.9.0", "3.11.9"]) {
      const result = eligible(id, python);
      assert.equal(result.eligible, false);
      if (!result.eligible) assert.match(result.reason, /Python 3\.8 requirement/);
    }
  }
});

test("Vision interpreter versions remain provenance, while unknown and changed contracts refuse reuse", () => {
  for (const id of ["vision-recognition", "vision-clustering"]) {
    for (const python of ["3.11.9", "3.11.10", "3.8.20"]) {
      assert.equal(eligible(id, python).eligible, true);
    }
    for (const contract of [null, 0, -1, 1.5, 2]) {
      assert.equal(eligible(id, "3.11.9", contract).eligible, false);
    }
  }
});

test("saved evidence never establishes eligibility for another repository name or catalog row", () => {
  const run = { preparedArtifactId: evidence.artifactId, preparedEnvironmentJson: JSON.stringify(evidence),
    benchmarkId: evidence.benchmarkId, repositoryId: evidence.source.repositoryId, sha: evidence.source.sha };
  assert.equal(savedEnvironmentEligibility(run, { id: evidence.benchmarkId, sandboxContract: 1 }, "other/repo").eligible, false);
  assert.equal(savedEnvironmentEligibility(run, { id: "vision-clustering", sandboxContract: 1 }, evidence.source.fullName).eligible, false);
});
