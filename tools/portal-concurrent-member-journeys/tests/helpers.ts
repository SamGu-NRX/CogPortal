import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext, type Page, test } from "@playwright/test";

export const JOIN_CODE = "VISION26";
/** The team the development demo login provisions into (created on first use). */
export const DEMO_TEAM = "Demo Team";

export type Member = { login: string; role: string };

/** The dev sign-in form on /signin. Returns after the session is set. */
export async function signIn(page: Page, login: string): Promise<void> {
  await page.goto("/signin");
  await page.locator("#dev-login").fill(login);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // The submit navigates away from the form (GitHub sign-in has its own button).
  await expect(page.locator("#dev-login")).toHaveCount(0, { timeout: 15_000 });
}

/** The cohort join form. Alpha renders the same form on /join and, for a
 *  member without a cohort, on /connect (the getting-started checklist). */
export async function joinCohort(page: Page, code = JOIN_CODE): Promise<void> {
  await page.goto("/join");
  const input = page.locator("#join-code");
  try {
    await input.waitFor({ state: "visible", timeout: 3_000 });
  } catch {
    return; // the page redirected: already in a cohort
  }
  await input.fill(code);
  await page.getByRole("button", { name: "Join the cohort" }).click();
  await expect(page).toHaveURL(/\/connect/, { timeout: 15_000 });
}

/** The team chooser on /connect: expand the collapsed list when the toggle is
 *  there, then the named team's own "Join <team>" button. A success lands on
 *  /setup. */
export async function joinTeam(page: Page, teamName = DEMO_TEAM): Promise<void> {
  await page.goto("/connect");
  const toggle = page.getByRole("button", { name: "Join a team someone already started" });
  if ((await toggle.count()) > 0) await toggle.click();
  const named = page.getByRole("button", { name: `Join ${teamName}` });
  // The chooser names every card's button after its team; this expectation is
  // the real assertion that the team is offered to this member.
  await expect(named).toBeVisible({ timeout: 15_000 });
  await named.click();
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 });
}

/** A session for API calls, from the same development sign-in the form uses
 *  (POST /api/dev/login). `demo: true` provisions the user into the cohort and
 *  onto the fixture-repository demo team in one step, which is what makes the
 *  server-side admin promotion below possible. */
export async function apiSession(request: APIRequestContext, login: string, { demo = true } = {}): Promise<void> {
  const response = await request.post("/api/dev/login", { data: { login, demo } });
  expect(response.status()).toBeLessThan(400);
}

/** The demo team's roster as the server stores it right now. A captured team
 *  id survives a concurrent rename; a name lookup does not. */
export async function roster(request: APIRequestContext, teamId?: string): Promise<Member[]> {
  const teams = await request.get("/api/cohorts/teams");
  expect(teams.status()).toBe(200);
  const list = (await teams.json()) as Array<{ id?: string; name: string; members: Member[] }>;
  return list.find((t) => (teamId ? t.id === teamId : t.name === DEMO_TEAM))?.members ?? [];
}

export async function rosterLogins(request: APIRequestContext, teamId?: string): Promise<string[]> {
  return (await roster(request, teamId)).map((m) => m.login);
}

/** The generated id of the dev-provisioned demo team, read through the API. */
export async function demoTeamId(request: APIRequestContext): Promise<string> {
  const teams = await request.get("/api/cohorts/teams");
  expect(teams.status()).toBe(200);
  const list = (await teams.json()) as Array<{ name: string; id: string }>;
  const team = list.find((t) => t.name === DEMO_TEAM);
  expect(team, "demo team provisioned").toBeTruthy();
  return team!.id;
}

/**
 * The local D1 survives between suite runs, and the journeys below rename
 * teams and create members. Before each describe, put the mutable parts of the
 * fixture back: the demo team's name, the synthetic people, their membership
 * rows, and the skewed run. Everything else stays as the migrations seeded it.
 */
export async function resetFixture(): Promise<void> {
  await d1(
    [
      `UPDATE teams SET name = '${DEMO_TEAM}' WHERE repo_full_name = 'cogworks-demo/face-finder' AND id != 'team_demo'`,
      `DELETE FROM runs WHERE id = 'run_skew_future'`,
      `DELETE FROM team_members WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'race-%@dev.local' OR email LIKE 'mobile-%@dev.local' OR email IN ('roster-watcher@dev.local', 'skew-reader@dev.local'))`,
      `DELETE FROM users WHERE email LIKE 'race-%@dev.local' OR email LIKE 'mobile-%@dev.local' OR email IN ('roster-watcher@dev.local', 'skew-reader@dev.local')`,
    ].join(";"),
  );
}

/** Horizontal overflow past the visible viewport, in pixels. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.scrollingElement as HTMLElement;
    return doc.scrollWidth - doc.clientWidth;
  });
}

/** One wrangler statement against the local development database, retried
 *  briefly in case the running Worker holds a lock. Used only to set up the
 *  world the journeys read (an admin role); never in place of driving the app. */
export function d1(statement: string): void {
  const suiteRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const wrangler = join(suiteRoot, "..", "..", "apps", "portal", "node_modules", ".bin", "wrangler");
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(wrangler, ["d1", "execute", "cogportal-db", "--local", "--command", statement], {
        cwd: join(suiteRoot, "..", "..", "apps", "portal"),
        stdio: "pipe",
      });
      return;
    } catch (error) {
      if (attempt >= 5) throw error;
    }
  }
}

export { test };
