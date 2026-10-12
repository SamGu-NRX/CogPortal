// S4, staff: a TA opens the process desk for their assigned team, under each
// staff visibility setting. The default ("assigned-teams") is today's view;
// "restricted" is the proposal awaiting the owner. Under restricted the TA's
// pages name no student and say what they withheld; an owner still reads
// everything. Under both, no run's log reaches a staff page.
//
// Setup the journey doesn't exercise is done in the run's D1: assigning the
// TA (the admin form assigns by GitHub login, which dev accounts don't
// carry) and nothing else.

import { test, expect } from "@playwright/test";
import { STACK, control, evidence, expectNoDispatch, fresh, signIn } from "./helpers.mjs";

const STUDENTS = ["rj-desk-student-one", "rj-desk-student-two"];
const TA = "rj-desk-ta";

async function setUp(browser, profile) {
  await fresh(profile);
  for (const login of STUDENTS) {
    const context = await browser.newContext();
    const student = await context.newPage();
    await signIn(student, login, { demo: true });
    await context.close();
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, TA);
  const [{ id: teamId }] = await control.sql(`SELECT id FROM teams WHERE name = 'Demo Team'`);
  await control.sql(
    `INSERT INTO team_tas (team_id, user_id, assigned_at) SELECT '${teamId}', id, 1 FROM users WHERE email = '${TA}@dev.local'`,
  );
  return { context, page, teamId };
}

async function openDesk(page) {
  await page.goto(`${STACK}/admin`);
  await page.getByRole("link", { name: "Desk" }).click();
  await expect(page).toHaveURL(`${STACK}/desk`);
  await expect(page.getByRole("heading", { name: "Where each team's work stands" })).toBeVisible();
  await page.getByRole("link", { name: /Demo Team/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Demo Team" })).toBeVisible();
}

test("by default a TA's desk shows their team's members, history state and runs", async ({ browser }) => {
  const { context, page } = await setUp(browser, "fixture");
  try {
    await openDesk(page);
    for (const login of STUDENTS) await expect(page.getByText(login)).toBeVisible();
    // Nobody has opened the Team page, so there is no read to show, and the
    // desk says that rather than presenting an empty history.
    await expect(page.getByText("Nobody on this team has opened their Team page yet")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
    await evidence(page, "staff-desk-team-default");

    await page.goto(`${STACK}/desk`);
    await expect(page.getByText("History not read yet")).toBeVisible();
    await evidence(page, "staff-desk-list");

    // /admin, under the same setting, still lists member logins for the TA.
    await page.goto(`${STACK}/admin`);
    await page.getByRole("button", { name: /Demo Team/ }).click();
    await expect(page.getByText(STUDENTS[0]).first()).toBeVisible();
    await expect(page.getByText("restricted staff setting")).toHaveCount(0);
  } finally {
    await context.close();
  }
  await expectNoDispatch();
});

test("under the restricted setting a TA's pages name no student and say what was withheld", async ({ browser }) => {
  const { context, page, teamId } = await setUp(browser, "fixture-restricted");
  try {
    await openDesk(page);
    await expect(page.getByText("2 students. Names are withheld.")).toBeVisible();
    await expect(page.getByText("Process findings are withheld under the restricted staff setting.")).toBeVisible();
    const deskText = await page.locator("main").innerText();
    for (const login of STUDENTS) expect(deskText).not.toContain(login);
    await evidence(page, "staff-desk-team-restricted");

    await page.goto(`${STACK}/admin`);
    await expect(page.getByText("This portal runs the restricted staff setting")).toBeVisible();
    await page.getByRole("button", { name: /Demo Team/ }).click();
    await expect(page.getByText("2 students. Names are withheld.")).toBeVisible();
    await expect(page.getByLabel("Add a student")).toHaveCount(0);
    const adminText = await page.locator("main").innerText();
    for (const login of STUDENTS) expect(adminText).not.toContain(login);

    // The Worker refuses the edit the page no longer offers.
    const add = await page.request.post(`${STACK}/api/admin/teams/${teamId}/members`, { data: { login: "someone" } });
    expect(add.status()).toBe(403);
  } finally {
    await context.close();
  }

  // An owner reads the names under the same setting.
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await signIn(owner, "owner-person");
  await owner.goto(`${STACK}/desk`);
  await owner.getByRole("link", { name: /Demo Team/ }).click();
  for (const login of STUDENTS) await expect(owner.getByText(login)).toBeVisible();
  await ownerContext.close();
  await expectNoDispatch();
});
