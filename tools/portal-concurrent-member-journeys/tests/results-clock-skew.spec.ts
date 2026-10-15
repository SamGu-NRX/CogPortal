import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { apiSession, DEMO_TEAM, resetFixture, signIn } from "./helpers";

// Clock skew (A8): a run whose own timestamps ran ahead of the Worker's — it
// starts two hours in the future and finishes three hours in the future,
// planted on the dev-provisioned demo team once that team exists. Whatever a
// clock skew does to a page, it must not turn a finished run into a running
// one or print an invalid date at anyone.

const SKEW_INSERT = `INSERT INTO runs
  (id, team_id, benchmark_id, benchmark_version, contract_version, mode, status, branch, sha,
   parent_run_id, attempt_number, failure_category, failure_phase, failure_detail,
   failure_consumed_attempt, log, created_at, finished_at)
VALUES
  ('run_skew_future', (SELECT id FROM teams WHERE name = '${DEMO_TEAM}'),
   'vision-recognition', 1, 'cogworks.submissions.v1', 'practice',
   'succeeded', 'main', '4444444444444444444444444444444444444444', NULL, NULL, NULL, NULL, NULL, 0,
   'Resolved ref refs/heads/main -> 4444444444444444444444444444444444444444' || CHAR(10) ||
   'contract check: 6/6 methods OK' || CHAR(10) ||
   'scorer summary: recognition_f1=0.9000',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 7200000,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 10800000);`;

test.describe("results under a skewed clock (A8)", () => {
  test.beforeAll(async ({ request }) => {
    // The demo login provisions the dev demo team the run belongs to.
    await resetFixture();
    await apiSession(request, "skew-reader", { demo: true });
    const suiteRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const wrangler = join(suiteRoot, "..", "..", "apps", "portal", "node_modules", ".bin", "wrangler");
    execFileSync(wrangler, ["d1", "execute", "cogportal-db", "--local", "--command", SKEW_INSERT], {
      cwd: join(suiteRoot, "..", "..", "apps", "portal"),
      stdio: "pipe",
    });
  });

  test("a finished run with future timestamps still reads as finished", async ({ page, request }) => {
    await apiSession(request, "skew-reader", { demo: true });
    // Sign in through the real form; the run page needs the session in the
    // browser, not only on the API fixture.
    await signIn(page, "skew-reader");
    await page.goto("/runs/run_skew_future");

    // The stored status is what the page reports, nothing about it running.
    await expect(page.getByText("Run status: Succeeded", { exact: true })).toBeAttached();

    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/Invalid Date/);

    // The duration renders from the stored pair (created +2 h, finished +3 h),
    // as a real duration, not a negative or malformed one.
    await expect(page.getByText(/\d+m \d{2}s/).first()).toBeVisible();
    expect(text).not.toMatch(/-\d+(\.\d+)?\s?(ms|s|m)/);
  });

  test("the signed-out leaderboard renders teams whose rows carry skewed clocks", async ({ page, request }) => {
    // No session anywhere: the leaderboard is public and unauthenticated.
    const response = await page.goto("/leaderboard");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Vision" })).toBeVisible();
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/Invalid Date/);

    // The board API answers signed out too.
    const board = await request.get("/api/leaderboard");
    expect(board.status()).toBe(200);
  });
});
