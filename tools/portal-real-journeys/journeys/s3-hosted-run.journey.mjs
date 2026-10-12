// S3, runs and results: a team member starts a hosted practice run from the
// Runs page, watches it to its end on the run page, and finds it in the
// team's history. The Worker runs the fixture execution provider, which
// advances a run through every phase on a wall clock and scripts its outcome
// by branch (packages/contracts/src/fixtures.ts); nothing is dispatched to a
// runner, and the Modal double's journal proves it.
//
// The second run uses the fixture's missing-adapter branch, so the run page
// shows the adapter_missing failure card a student would read.

import { test, expect } from "@playwright/test";
import { STACK, evidence, expectNoDispatch, fresh, signIn } from "./helpers.mjs";

async function startFromRunsPage(page, branch) {
  await page.goto(`${STACK}/dashboard`);
  await page.getByLabel("Branch").selectOption(branch);
  const before = await (await page.request.get(`${STACK}/api/runs`)).json();
  await page.getByRole("button", { name: "Run practice benchmark" }).click();
  await expect
    .poll(async () => (await (await page.request.get(`${STACK}/api/runs`)).json()).length, { timeout: 15_000 })
    .toBe(before.length + 1);
  const after = await (await page.request.get(`${STACK}/api/runs`)).json();
  const started = after.find((run) => !before.some((old) => old.id === run.id));
  expect(started.branch).toBe(branch);
  expect(started.mode).toBe("practice");
  return started;
}

test("a practice run goes from the Runs page to a scored result and into the history", async ({ page }) => {
  test.setTimeout(180_000);
  await fresh();
  await signIn(page, "rj-runner-student", { demo: true });

  const run = await startFromRunsPage(page, "main");
  await page.goto(`${STACK}/runs/${run.id}`);
  // The fixture's phases take about 21 seconds in all.
  await expect(page.getByText("Succeeded").first()).toBeVisible({ timeout: 60_000 });
  // The run page leads with what the run shows, then the number.
  await expect(page.getByText("What this run shows")).toBeVisible();

  // Back on the Runs page the finished run is in the history, and a reload
  // (a fresh read from D1) keeps it.
  await page.goto(`${STACK}/dashboard`);
  await page.reload();
  const runs = await (await page.request.get(`${STACK}/api/runs`)).json();
  expect(runs.find((r) => r.id === run.id)?.status).toBe("succeeded");
  await expect(page.locator(`a[href="/runs/${run.id}"]`).first()).toBeVisible();
  await expectNoDispatch();
});

test("a run that finds no adapter fails with the neutral card and the raw line folded", async ({ page }) => {
  test.setTimeout(180_000);
  await fresh();
  await signIn(page, "rj-failing-student", { demo: true });

  const run = await startFromRunsPage(page, "missing-adapter");
  await page.goto(`${STACK}/runs/${run.id}`);
  await expect(page.getByText("Nothing here could be scored")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("E-ADAPTER").first()).toBeVisible();
  await expect(page.getByText("Run the check below", { exact: false })).toBeVisible();
  // The fixture's raw line is packaging machinery: on the card, but behind
  // the fold. (The practice log further down carries it too, as logs do.)
  const raw = page
    .locator("pre:not([data-log])")
    .filter({ hasText: 'Entry-point group "cogworks.submissions.v2" has no registration for this benchmark.' });
  // Folded means inside the card's veil, which is aria-hidden and inert
  // until opened (components/Veil.tsx).
  const veiled = raw.locator('xpath=ancestor::*[@aria-hidden="true"]');
  await expect(veiled).toHaveCount(1);
  await evidence(page, "failure-card-adapter-missing");
  await page.getByRole("button", { name: "Show details" }).click();
  await expect(veiled).toHaveCount(0);
  await expect(raw).toBeVisible();
  await evidence(page, "failure-card-adapter-missing-details");

  // Failed runs don't use the hosted budget.
  const failed = (await (await page.request.get(`${STACK}/api/runs`)).json()).find((r) => r.id === run.id);
  expect(failed.status).toBe("failed");
  expect(failed.failure).toMatchObject({ category: "adapter_missing", phase: "contract_check" });
  await expectNoDispatch();
});
