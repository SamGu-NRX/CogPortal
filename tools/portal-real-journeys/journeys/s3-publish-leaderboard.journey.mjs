// S3 to S1: a team takes a practice run through promotion and publishing,
// and a visitor who isn't signed in finds it on the public leaderboard.
//
// Every step is the student's own button: Run practice benchmark on the Runs
// page, Promote to official on the finished run, Publish result on the
// official run's console. The Worker runs the fixture execution provider, so
// the runs' numbers are its scripted ones (packages/contracts/src/fixtures.ts);
// what this journey proves is the path from a run to the public board on the
// active benchmark version, not the scoring.

import { test, expect } from "@playwright/test";
import { STACK, evidence, expectNoDispatch, fresh, signIn } from "./helpers.mjs";

const runsOf = async (page) => (await page.request.get(`${STACK}/api/runs`)).json();

async function waitForRun(page, predicate, timeout = 90_000) {
  let found;
  await expect
    .poll(async () => {
      found = (await runsOf(page)).find(predicate);
      return found?.status;
    }, { timeout })
    .toBe("succeeded");
  return found;
}

test("a published official result shows on the leaderboard for a signed-out visitor", async ({ page, browser }) => {
  test.setTimeout(300_000);
  await fresh();
  await signIn(page, "rj-publishing-student", { demo: true });

  // Practice run from the Runs page.
  await page.goto(`${STACK}/dashboard`);
  await page.getByRole("button", { name: "Run practice benchmark" }).click();
  const practice = await waitForRun(page, (run) => run.mode === "practice");

  // Promote it from the Runs page; the confirm names the attempt it uses.
  await page.goto(`${STACK}/dashboard`);
  await page.getByRole("button", { name: "Promote to official" }).first().click();
  await page.getByRole("button", { name: /Confirm, uses attempt 1 of/ }).click();
  const official = await waitForRun(page, (run) => run.mode === "official");
  // The practice run records the official run it became.
  expect((await (await page.request.get(`${STACK}/api/runs/${practice.id}`)).json()).promotedTo).toMatchObject({ runId: official.id });

  // Publish from the official run's console.
  const detail = await (await page.request.get(`${STACK}/api/runs/${official.id}`)).json();
  expect(detail.surfaceId, "the official run has a console").toBeTruthy();
  await page.goto(`${STACK}/run-surfaces/${detail.surfaceId}`);
  await page.getByRole("button", { name: "Publish result" }).click();
  await expect(page.getByRole("dialog")).toContainText(`Publish ${official.shortSha} to the public leaderboard?`);
  await page.getByRole("dialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A visitor with no session reads it on the board for the run's benchmark,
  // which is the active version's.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  try {
    const board = await (await visitor.request.get(`${STACK}/api/leaderboard?benchmark=${official.benchmarkId}`)).json();
    expect(board.benchmark.id).toBe(official.benchmarkId);
    expect(board.benchmark.active).toBe(true);
    const entry = board.entries.find((e) => e.teamName === "Demo Team");
    expect(entry, JSON.stringify(board.entries).slice(0, 400)).toMatchObject({ sha: detail.sha, isYou: false });
    expect(entry.primaryMetric.value).toBe(detail.metrics.find((m) => m.primary).value);

    // The board's own link for a benchmark, as the Runs page and Discord give it.
    await visitor.goto(`${STACK}/leaderboard?benchmark=${official.benchmarkId}`);
    await expect(visitor.getByRole("tab", { selected: true })).toBeVisible();
    const row = visitor
      .getByRole("list", { name: "Published results, newest first" })
      .getByRole("listitem")
      .filter({ has: visitor.getByRole("heading", { name: "Demo Team" }) });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`${entry.primaryMetric.label} ${entry.primaryMetric.value.toFixed(entry.primaryMetric.precision)}`);
    await row.getByRole("button", { name: "Details for Demo Team" }).click();
    await expect(row).toContainText(entry.shortSha);
    await evidence(visitor, "leaderboard-signed-out-published");
  } finally {
    await visitorContext.close();
  }
  await expectNoDispatch();
});
