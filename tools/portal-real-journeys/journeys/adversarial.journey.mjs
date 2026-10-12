// M2, the adversarial classes beyond a double submit (s6-activity-link) and a
// Worker restart (ops-restart-and-production), on the real stack. Each case
// states what the student must be left with: their data kept, a page that
// tells the truth, and a way forward.
//
// A1 delayed, lost and reordered traffic, shaped at the proxy between the
//    browser and the Worker.
// A2 two tabs of one session.
// A3 a page cached from before a team change.
// A6 malformed and oversized results, through the CLI's own report route.
// A7 long, right-to-left and emoji names, end to end.

import { test, expect } from "@playwright/test";
import { STACK, control, evidence, expectNoDispatch, fresh, signIn } from "./helpers.mjs";
import { expectAccessible } from "./a11y.mjs";
import { call, devLogin, linkDevice } from "./world.mjs";

const runsOf = async (page) => (await page.request.get(`${STACK}/api/runs`)).json();

test.afterEach(async () => {
  await control.clearFaults();
});

test.describe("A1 delayed, lost and reordered traffic", () => {
  test("a slow start keeps the button busy and starts one run", async ({ page }) => {
    await fresh();
    await signIn(page, "rj-a1-slow", { demo: true });
    await page.goto(`${STACK}/dashboard`);
    await control.fault({ method: "POST", path: "^/api/runs/practice$", delayMs: 3000, times: 1 });
    const button = page.getByRole("button", { name: "Run practice benchmark" });
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "true");
    // A second click while the first is in flight is ignored.
    await button.click({ force: true }).catch(() => {});
    await expect.poll(async () => (await runsOf(page)).length, { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(1500);
    expect((await runsOf(page)).length).toBe(1);
    await expectNoDispatch();
  });

  test("a start whose request is lost says so, keeps the page usable, and starts nothing", async ({ page }) => {
    await fresh();
    await signIn(page, "rj-a1-lost", { demo: true });
    await page.goto(`${STACK}/dashboard`);
    // Every send dropped until the page gives up: Chromium silently resends a
    // POST whose connection closes before any answer (twice, measured on this
    // stack), so a single drop never reaches the page.
    await control.fault({ method: "POST", path: "^/api/runs/practice$", drop: true, times: 10 });
    await page.getByRole("button", { name: "Run practice benchmark" }).click();
    await expect(page.getByRole("alert")).toHaveText("Could not reach the portal. Check your connection and try again.");
    await control.clearFaults();
    expect(await runsOf(page)).toEqual([]);
    // The way forward: the same button, which now works.
    await page.getByRole("button", { name: "Run practice benchmark" }).click();
    await expect.poll(async () => (await runsOf(page)).length).toBe(1);
    await expectNoDispatch();
  });

  test("a start whose answer is lost says so, and a reload shows the run that did start", async ({ page }) => {
    await fresh();
    await signIn(page, "rj-a1-lost-answer", { demo: true });
    await page.goto(`${STACK}/dashboard`);
    // Chromium resends the POST when its answer is lost (see above), so the
    // Worker sees the start more than once. It starts one run and refuses the
    // rest; the page reports either the lost connection or that refusal, and
    // both are true.
    await control.fault({ method: "POST", path: "^/api/runs/practice$", dropResponse: true, times: 10 });
    await page.getByRole("button", { name: "Run practice benchmark" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      /^(Could not reach the portal\. Check your connection and try again\.|A run is already in progress; runs go one at a time per benchmark\.)$/,
    );
    await control.clearFaults();
    // One run, not one per resend; the page, once reloaded, shows it.
    await expect.poll(async () => (await runsOf(page)).length).toBe(1);
    await page.waitForTimeout(1500);
    expect((await runsOf(page)).length).toBe(1);
    const [run] = await runsOf(page);
    await page.reload();
    await expect(page.locator(`a[href="/runs/${run.id}"]`).first()).toBeVisible();
    await expectNoDispatch();
  });

  test("two renames that reach the Worker in the opposite order leave the page showing what was stored", async ({ page }) => {
    await fresh();
    await signIn(page, "rj-a1-reorder", { demo: true });
    await page.goto(`${STACK}/team`);
    // The first save is held back long enough for the second to land first.
    await control.fault({ method: "PATCH", path: "^/api/team$", delayMs: 2500, times: 1 });
    for (const name of ["RJ First Name", "RJ Second Name"]) {
      await page.getByRole("button", { name: "Rename" }).click();
      await page.getByLabel("Team name").fill(name);
      await page.getByRole("button", { name: "Save name" }).click();
      if (name === "RJ First Name") await expect(page.getByLabel("Team name")).toHaveCount(1);
    }
    await page.waitForTimeout(4000);
    const stored = (await (await page.request.get(`${STACK}/api/team`)).json()).name;
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(stored);
  });
});

test.describe("A2 two tabs", () => {
  test("a tab left open after leaving the team in another can't start a run on it", async ({ browser }) => {
    await fresh();
    const context = await browser.newContext();
    const first = await context.newPage();
    const session = await signIn(first, "rj-a2-tabs", { demo: true });
    await first.goto(`${STACK}/dashboard`);
    await expect(first.getByRole("button", { name: "Run practice benchmark" })).toBeVisible();

    const second = await context.newPage();
    const leave = await second.request.post(`${STACK}/api/team/leave`, { data: { teamId: session.team.id } });
    expect(leave.status()).toBe(200);

    await first.getByRole("button", { name: "Run practice benchmark" }).click();
    await expect(first.getByRole("alert").or(first.getByRole("status").filter({ hasText: "out of date" }))).toBeVisible();
    expect((await control.sql("SELECT count(*) AS n FROM runs WHERE team_id = '" + session.team.id + "' AND created_at > 1790000000000"))[0].n).toBe(0);
    await first.reload();
    await expect(first).toHaveURL(new RegExp(`${STACK}/(connect|join)`));
    await context.close();
  });
});

test.describe("A3 stale cache after a team change", () => {
  test("a Runs page loaded before an owner removed the student refuses to start and recovers on reload", async ({ browser }) => {
    await fresh();
    const context = await browser.newContext();
    const page = await context.newPage();
    // The teammate starts the team, so the student under test isn't its
    // admin (an admin can't be removed).
    await devLogin("rj-a3-teammate", { demo: true });
    const session = await signIn(page, "rj-a3-removed", { demo: true });
    await page.goto(`${STACK}/dashboard`);
    await expect(page.getByRole("button", { name: "Run practice benchmark" })).toBeVisible();

    const owner = await devLogin("owner-person");
    // The admin route finds people by GitHub login, which dev accounts don't
    // carry; give this one a synthetic login so the owner's real removal
    // path can find them.
    await control.sql(`UPDATE users SET github_login = 'rj-a3-removed' WHERE email = 'rj-a3-removed@dev.local'`);
    const removed = await call("DELETE", `/api/admin/teams/${session.team.id}/members/rj-a3-removed`, { who: owner });
    expect(removed.status, removed.text).toBe(200);
    expect(await control.sql(`SELECT count(*) AS n FROM team_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'rj-a3-removed@dev.local'`)).toEqual([{ n: 0 }]);

    await page.getByRole("button", { name: "Run practice benchmark" }).click();
    await expect(page.getByRole("alert").or(page.getByRole("status").filter({ hasText: "out of date" }))).toBeVisible();
    expect(await control.sql(`SELECT id FROM runs WHERE team_id = '${session.team.id}'`)).toEqual([]);
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${STACK}/(connect|join)`));
    await context.close();
  });
});

test.describe("A6 malformed and oversized results", () => {
  test("reports the contract can't hold are refused in words, store nothing, and the Runs page still renders", async ({ page }) => {
    await fresh();
    const session = await signIn(page, "rj-a6-reports", { demo: true });
    const who = await devLogin("rj-a6-reports");
    const device = await linkDevice(who, "rj-a6-device");
    const benchmarks = (await call("GET", "/api/benchmarks")).json;
    // Week 1 is closed in the seed; the CLI still reports on it.
    const version = benchmarks.find((b) => b.id === "audio-identification").version;
    const base = {
      reportId: "rj-a6-good-report",
      benchmarkId: "audio-identification",
      benchmarkVersion: version,
      contractVersion: "cogworks.submissions.v2",
      sdkVersion: "0.2.0",
      pluginVersion: "0.1.0",
      repositoryId: null,
      repositoryFullName: session.team.repo.fullName,
      sha: "a".repeat(40),
      dirty: false,
      startedAt: 1_790_000_000_000,
      finishedAt: 1_790_000_060_000,
      metrics: [{ key: "top1", label: "Top-1", value: 0.5, unit: null, higherIsBetter: true, primary: true, precision: 3, role: "scored" }],
      diagnostics: ["A plain note."],
      weightsUsed: [],
      weightsUploaded: [],
      command: "run",
    };
    const metric = base.metrics[0];
    const cases = {
      "33 metrics": { ...base, reportId: "rj-a6-1", metrics: Array.from({ length: 33 }, (_, i) => ({ ...metric, key: `m${i}`, primary: i === 0 })) },
      "a 241-character note": { ...base, reportId: "rj-a6-2", diagnostics: ["x".repeat(241)] },
      "a value that isn't a number": { ...base, reportId: "rj-a6-3", metrics: [{ ...metric, value: "NaN" }] },
      "precision 7": { ...base, reportId: "rj-a6-4", metrics: [{ ...metric, precision: 7 }] },
      "no metrics key": (() => { const { metrics, ...rest } = base; void metrics; return { ...rest, reportId: "rj-a6-5" }; })(),
      "a bad commit": { ...base, reportId: "rj-a6-6", sha: "not-a-sha" },
    };
    for (const [label, body] of Object.entries(cases)) {
      const result = await call("POST", "/api/v1/local-reports", { who: device, body });
      expect(result.status, `${label}: ${result.text}`).toBe(400);
      expect(result.json?.error?.code, label).toBe("invalid_request");
      expect(result.json?.error?.message, label).toBeTruthy();
    }
    // Not JSON at all, and a body far past any report's size.
    const garbage = await call("POST", "/api/v1/local-reports", { who: device, body: "{not json" });
    expect(garbage.status, garbage.text).toBe(400);
    const tooMany = await call("POST", "/api/v1/local-reports", { who: device, body: { ...base, reportId: "rj-a6-7", diagnostics: Array(33).fill("y".repeat(240)) } });
    expect(tooMany.status, tooMany.text).toBe(400);
    expect(await control.sql("SELECT report_id FROM local_reports")).toEqual([]);

    // A report padded to 4 MB with a field the contract doesn't know: the
    // Worker has no body-size cap, parses it, drops the unknown field and
    // stores the report. Recorded here as observed (PR Handoff), not as policy.
    const padded = await call("POST", "/api/v1/local-reports", { who: device, body: { ...base, reportId: "rj-a6-padded", padding: "z".repeat(4_000_000) } });
    expect(padded.status, padded.text.slice(0, 200)).toBe(201);
    expect(padded.json.padding).toBeUndefined();
    const [row] = await control.sql("SELECT length(metrics_json) + length(diagnostics_json) AS size FROM local_reports WHERE report_id = 'rj-a6-padded'");
    expect(row.size).toBeLessThan(2000);
    await control.sql("DELETE FROM local_reports WHERE report_id = 'rj-a6-padded'");

    // A report the contract allows but with extreme values still renders.
    const extreme = { ...base, metrics: [{ ...metric, value: 1e308 }, { ...metric, key: "neg", label: "Negative", primary: false, value: -0.000001 }] };
    const stored = await call("POST", "/api/v1/local-reports", { who: device, body: extreme });
    expect(stored.status, stored.text).toBe(201);
    await page.goto(`${STACK}/dashboard?benchmark=audio-identification`);
    await expect(page.getByRole("heading", { name: "Local reports" })).toBeVisible();
    await expect(page.getByText("A plain note.")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("A7 long, right-to-left and emoji names", () => {
  // Exactly the 60-character limit, which the contract and the rename field
  // both count in UTF-16 units (an emoji is two, a ZWJ sequence more):
  // Arabic, an emoji ZWJ sequence with a skin tone, Hebrew, a right-to-left
  // override, combining marks and Latin.
  const NAME = "فريق 🧑🏽‍🔬 צוות ‮RTL‬ Ünïcödé ñ̃ 🧪 Long name check okay77";

  test("a team named in mixed scripts at the length limit reads correctly everywhere it appears", async ({ page }) => {
    await fresh();
    const session = await signIn(page, "rj-a7-names", { demo: true });
    expect(NAME.length).toBe(60);
    const rename = await page.request.patch(`${STACK}/api/team`, { data: { teamId: session.team.id, name: NAME } });
    expect(rename.status(), await rename.text()).toBe(200);
    const tooLong = await page.request.patch(`${STACK}/api/team`, { data: { teamId: session.team.id, name: `${NAME}x` } });
    expect(tooLong.status()).toBe(400);
    expect((await (await page.request.get(`${STACK}/api/team`)).json()).name).toBe(NAME.trim());

    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
      await page.goto(`${STACK}/team`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(NAME.trim());
      await expectAccessible(page, `team page with a mixed-script name at ${width}`);
      await page.goto(`${STACK}/dashboard`);
      await expect(page.locator("main").getByText(NAME.trim()).first()).toBeVisible();
      await expectAccessible(page, `runs page with a mixed-script name at ${width}`);
    }
    await evidence(page, "a7-mixed-script-team-320");
  });
});
