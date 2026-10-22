// S2, onboarding: a new student signs in, joins the seeded cohort with its
// code, starts a team on the fixture repository, and links the real
// `cogworks` CLI (python/cogbench, run on Python 3.8 as the course does)
// through the device flow, approving it in the portal.
//
// The CLI runs with its own HOME and COGBENCH_CONFIG in a temp directory, so
// it never reads or writes the developer's ~/.cogbench, and its only portal
// is this run's proxy.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { STACK, control, expectNoDispatch, fresh } from "./helpers.mjs";
import { makeHome, requirePython, startLink } from "./cli.mjs";

/** The sign-in page's development form, opened if its fold is closed. */
async function devSignIn(page, login) {
  await page.goto(`${STACK}/signin`);
  // The fold renders once the session says dev sign-in is on, open by
  // default when GitHub isn't configured. Wait for it before deciding,
  // or a click meant to open it closes it.
  const fold = page.getByText("Development sign-in");
  await expect(fold).toBeVisible();
  const field = page.getByLabel("Sign in as");
  if (!(await field.isVisible())) await fold.click();
  await field.fill(login);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("a new student signs in, joins, starts a team, and links the CLI", async ({ page }) => {
  requirePython();
  await fresh();

  await devSignIn(page, "rj-onboarding-student");

  await expect(page).toHaveURL(`${STACK}/join`);
  await page.getByLabel("Join code").fill("vision26");
  await page.getByRole("button", { name: "Join the cohort" }).click();

  await expect(page).toHaveURL(new RegExp(`${STACK}/connect`));
  await page.getByText("Start a new team").click();
  await page.getByRole("radio", { name: /cogworks-demo\/face-finder/ }).check();
  await page.getByLabel("Team name").fill("RJ Parity Checkers");
  await page.getByRole("button", { name: "Create RJ Parity Checkers" }).click();
  await expect(page).toHaveURL(`${STACK}/setup`);

  const session = await (await page.request.get(`${STACK}/api/session`)).json();
  expect(session.team?.name).toBe("RJ Parity Checkers");

  // The repositories listing and the cohort roster both read the new
  // membership back (assertions restored from j1-real-github-oauth).
  const repos = await (await page.request.get(`${STACK}/api/github/repositories`)).json();
  const fixture = repos.find((r) => r.fullName === "cogworks-demo/face-finder");
  expect(fixture?.claimedByTeam).toBe("RJ Parity Checkers");
  const roster = await (await page.request.get(`${STACK}/api/cohorts/teams`)).json();
  expect(JSON.stringify(roster)).toContain("RJ Parity Checkers");

  const home = makeHome();
  const cli = startLink(STACK, { cwd: home, home });
  try {
    const { uri, code } = await cli.prompt;
    expect(new URL(uri).origin).toBe(STACK);
    await page.goto(uri);
    await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
    await expect(page.getByText(code, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Approve device" }).click();

    expect(await cli.exited, cli.output()).toBe(0);
    expect(cli.output()).toMatch(/Linked .+\. Local commands still work offline\./);
    const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    expect(Object.keys(config.portals)).toEqual([STACK]);

    // The portal lists the device for this student, and only one.
    const devices = await control.sql(
      `SELECT count(*) AS n FROM cli_devices d JOIN users u ON u.id = d.user_id WHERE u.email = 'rj-onboarding-student@dev.local' AND d.revoked_at IS NULL`,
    );
    expect(devices).toEqual([{ n: 1 }]);
  } finally {
    cli.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
  await expectNoDispatch();
});

test("a wrong join code is refused in words and nothing is joined", async ({ page }) => {
  await fresh();
  await devSignIn(page, "rj-mistyped-student");
  await expect(page).toHaveURL(`${STACK}/join`);
  await page.getByLabel("Join code").fill("NOTACODE");
  await page.getByRole("button", { name: "Join the cohort" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(`${STACK}/join`);
  const session = await (await page.request.get(`${STACK}/api/session`)).json();
  expect(session.cohort).toBeNull();
});
