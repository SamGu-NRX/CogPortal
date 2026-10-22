// S3 local reports, end to end: a team member scores the Week 1 reference
// submission with the real `cogworks` CLI on Week 1's public data (generated
// locally, so offline), links the CLI by device code, syncs the report, and
// the portal shows the report the CLI produced, number for number.
//
// Nothing here is a scripted score. The numbers come from `cogworks run` on
// Python 3.8; the journey compares what the Worker stores and the Runs page
// shows against the CLI's own JSON. The repository is a local git repository
// whose `origin` names the team's GitHub repository, which is all the CLI
// reads to attribute a report. The Week 1 reference submission it scores is
// staff code from examples/, not a student's.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { STACK, control, evidence, expectNoDispatch, fresh, signIn } from "./helpers.mjs";
import { cogworks, makeHome, makeWeek1Project, requirePython, startLink } from "./cli.mjs";

const BENCHMARK = "audio-identification";

/** The value at the metric's own precision, as the report table prints it. */
function shownValue(metric) {
  return metric.value.toFixed(metric.precision);
}

test("a real Week 1 run, synced by the CLI, reads back unchanged through the API and the Runs page", async ({ page }) => {
  test.setTimeout(900_000);
  requirePython();
  await fresh();
  const session = await signIn(page, "rj-cli-reporter", { demo: true });
  const repo = session.team.repo.fullName;
  expect(repo, "the demo team's repository").toBeTruthy();

  const home = makeHome();
  try {
    const project = makeWeek1Project(home, repo);

    // Offline first, as the course runs it: the smoke test, then the full
    // public practice set. Neither may need the portal; it isn't linked yet.
    const smoke = await cogworks(["test", "--benchmark", BENCHMARK, "--json"], { cwd: project.root, home });
    expect(smoke.code, `${smoke.stdout}\n${smoke.stderr}`).toBe(0);
    expect(JSON.parse(smoke.stdout).command).toBe("test");

    const run = await cogworks(["run", "--benchmark", BENCHMARK, "--json"], { cwd: project.root, home });
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report.command).toBe("run");
    expect(report.benchmarkId).toBe(BENCHMARK);
    expect(report.sha).toBe(project.sha);
    expect(report.repositoryFullName).toBe(repo);
    expect(report.metrics.length).toBeGreaterThan(0);
    const primary = report.metrics.find((metric) => metric.primary);
    expect(primary, "the report names a primary metric").toBeTruthy();
    fs.writeFileSync(path.join("test-results", "evidence", "cli-week1-report.json"), run.stdout);

    // Link by device code, approved in the portal by the same student.
    const link = startLink(STACK, { cwd: project.root, home });
    try {
      const { uri, code } = await link.prompt;
      await page.goto(uri);
      await expect(page.getByText(code, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Approve device" }).click();
      expect(await link.exited, link.output()).toBe(0);
    } finally {
      link.kill();
    }

    const sync = await cogworks(["sync"], { cwd: project.root, home });
    expect(sync.code, `${sync.stdout}\n${sync.stderr}`).toBe(0);
    expect(sync.stdout).toContain(`Synced ${report.reportId} as LOCAL RUN · SELF-REPORTED.`);

    // The seeded catalog has Week 1 closed (audio-identification v1 is not
    // active), so the Worker files the report under benchmarks with no track
    // and the Runs page shows it in that group. Same id, commit, command and
    // every metric value and note as the CLI's own JSON, labelled self-reported.
    const untracked = await page.request.get(`${STACK}/api/v1/local-reports?untracked=1`);
    expect(untracked.status()).toBe(200);
    const reports = await untracked.json();
    expect(reports.map((r) => r.reportId)).toEqual([report.reportId]);
    const stored = reports[0];
    expect(stored).toMatchObject({
      benchmarkId: BENCHMARK,
      benchmarkVersion: report.benchmarkVersion,
      sha: project.sha,
      repositoryFullName: repo,
      command: "run",
      trust: "local_self_reported",
    });
    expect(stored.metrics.map((m) => [m.key, m.value, m.primary])).toEqual(report.metrics.map((m) => [m.key, m.value, m.primary]));
    expect(stored.diagnostics).toEqual(report.diagnostics);

    // Syncing the same report again changes nothing.
    const again = await cogworks(["sync"], { cwd: project.root, home });
    expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(0);
    expect(await control.sql("SELECT count(*) AS n FROM local_reports")).toEqual([{ n: 1 }]);

    const expectRow = async (table) => {
      await expect(table).toBeVisible();
      await expect(table.getByText(report.diagnostics[0]).first()).toBeVisible();
      await expect(table.getByText(`${primary.label} ${shownValue(primary)}`).first()).toBeVisible();
      await expect(table.getByText(project.sha.slice(0, 7)).first()).toBeVisible();
      await expect(table.getByText("cogworks run").first()).toBeVisible();
    };
    await page.goto(`${STACK}/dashboard`);
    const section = page.locator('section[aria-labelledby="local-reports-heading"]');
    await expect(section.getByRole("heading", { name: "Local reports" })).toBeVisible();
    await expect(section.getByRole("heading", { name: "Benchmarks not open for hosted runs" })).toBeVisible();
    await expectRow(section.getByRole("table", { name: "Self-reported local CogBench results for benchmark versions without a track" }));
    await evidence(page, "runs-page-local-report-week1-untracked");

    // In Week 1 the course opens the audio track (here, the catalog row is
    // switched on in D1; no route does that). The same report then belongs to
    // the track and shows in its own table.
    await control.sql(`UPDATE benchmarks SET active = 1 WHERE id = '${BENCHMARK}' AND version = ${report.benchmarkVersion}`);
    const tracked = await (await page.request.get(`${STACK}/api/v1/local-reports?benchmark=${BENCHMARK}`)).json();
    expect(tracked.map((r) => r.reportId)).toEqual([report.reportId]);
    expect(await (await page.request.get(`${STACK}/api/v1/local-reports?untracked=1`)).json()).toEqual([]);
    await page.goto(`${STACK}/dashboard?benchmark=${BENCHMARK}`);
    await expectRow(section.getByRole("table", { name: "Self-reported local CogBench results" }));
    await evidence(page, "runs-page-local-report-week1-track");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  await expectNoDispatch();
});
