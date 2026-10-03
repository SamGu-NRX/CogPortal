import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import { randomUUID } from 'node:crypto';
import { joinCohort, joinTeam, leaveTeam, pendingCode, sessionState } from '../support/accounts.ts';
import { CliHome } from '../support/cli.ts';
import { findAttemptDevice, revokeAttemptDevice, type AttemptDevice } from '../support/devices.ts';
import { TEAM, browserPortal, devLogin, startLink } from '../support/link.ts';
import { LOCAL_ORIGIN } from '../support/local-origin.ts';

// The same start as teamless-link.e2e.ts: `cogworks link` before the student
// has a team, so the stage guard sends the printed link on to Connect. Since
// fix/pending-device-link the guard also keeps that path in the tab, for the
// account that opened it, and once the student has joined a team Setup asks
// the status endpoint about the code and offers the same approval page as a
// link. These tests follow that offer instead of reopening the printed link
// (teamless-link.e2e.ts keeps the reopening path), and check where the held
// link must not go: to another account in the same tab, to a code that's
// been used, and into `/` or /signin.
//
// Each attempt makes its own accounts, so their memberships and devices are
// theirs to remove. The two link-team students are never signed in.
const COHORT_CODE = 'VISION26'; // apps/portal/scripts/seed-local.sql
const COHORT = 'bwsi-2026';
const TEAM_ID = 'team_e2e_pilot'; // fixtures/link-team.sql
const HELD_KEY = 'cogportal.heldDeviceLink'; // apps/portal/src/lib/held-device-link.ts
const OFFER = 'Your earlier device link'; // the offer's region label

type Held = { path: string; userCode: string; login: string };

/** The tab's held link, as the portal stored it. */
function heldLink(browser: Browser): Promise<Held | null> {
  return browser.evaluate(
    (key: string) => JSON.parse(sessionStorage.getItem(key) ?? 'null') as Held | null,
    HELD_KEY,
  );
}

/** Where the tab is: path and query, which is what the approval link carries. */
async function here(browser: Browser): Promise<string> {
  const url = new URL(await browser.url());
  return `${url.pathname}${url.search}`;
}

/** Signs a new synthetic account into this tab and puts it in the cohort, with no team. */
async function newStudent(browser: Browser, login: string): Promise<void> {
  expect(await devLogin(browser, login)).toBe(200);
  expect(await joinCohort(browser, COHORT_CODE)).toBe(200);
  expect(await sessionState(browser)).toEqual({ cohort: COHORT, team: null });
}

/** Leaves whatever team `login` is on; returns what went wrong, if anything. */
async function leaveIfOnTeam(browser: Browser, login: string): Promise<string | undefined> {
  try {
    if ((await devLogin(browser, login)) !== 200) return `signing ${login} in for teardown failed`;
    const { team } = await sessionState(browser);
    if (!team) return undefined;
    const left = await leaveTeam(browser, team.id);
    return left === 200 ? undefined : `${login} leaving ${team.id} returned ${left}`;
  } catch (error) {
    return `checking ${login}'s team: ${String(error)}`;
  }
}

test(
  "a teamless student links the CLI by following Setup's offer after joining a team",
  { timeout: 240_000 },
  async ({ app, agent, browser, screen }) => {
    const home = await CliHome.create();
    const portal = browserPortal(browser);
    const suffix = randomUUID().slice(0, 8);
    const student = `e2e-pilot-d-${suffix}`;
    const deviceName = `E2E pilot ${suffix}`;
    const observed: Record<string, unknown> = { student };
    let attempt: AttemptDevice | undefined;
    let deviceId: string | undefined;
    let completed = false;
    try {
      const link = await startLink(home);
      observed.code = link.code;
      observed.printedPath = link.path;

      await app.open('/');
      await newStudent(browser, student);
      // A new account has no devices, so any device under this name is this attempt's.
      attempt = { login: student, before: [], name: deviceName };

      // The printed link, opened with no team: sent to Connect, told why, and
      // the path kept for this account.
      await app.open(link.path);
      await expect(browser).toHaveURL('/connect');
      await expect(screen.getByText('Your device link is on hold')).toBeVisible();
      const notice = await browser.evaluate(() =>
        Array.from(document.querySelectorAll('[role="status"]'))
          .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
          .find((text) => text.startsWith('Your device link is on hold')) ?? null,
      );
      observed.notice = notice;
      expect(notice).toContain('Setup in this tab offers the link again while its code is still valid');
      expect(notice).toContain('press Ctrl+C in that terminal');
      expect(await heldLink(browser)).toEqual({ path: link.path, userCode: link.code, login: student });
      expect(await pendingCode(browser, link.code)).toEqual({ valid: true, approved: false });
      await app.screenshot('dropped-link-notice');

      // The agent joins the existing team through the UI.
      await agent.act('join the team called {team}', {
        params: { team: TEAM },
        maxSteps: 8,
        maxModelCalls: 10,
        timeout: 90_000,
      });
      await expect(browser).toHaveURL('/setup');
      expect(await sessionState(browser)).toEqual({ cohort: COHORT, team: { id: TEAM_ID, name: TEAM } });

      // Setup offers the held link: this code, as a link to the printed path.
      const offer = screen.getByRole('region', { name: OFFER });
      await expect(offer).toBeVisible();
      await expect(offer).toContainText(`Code ${link.code} hasn't expired or been approved.`);
      const follow = offer.getByRole('link', { name: 'Review and approve' });
      await expect(follow).toHaveAttribute('href', link.path);
      observed.offer = await browser.evaluate(
        (label: string) => {
          const region = document.querySelector(`section[aria-label="${label}"]`);
          return region
            ? { text: (region.textContent ?? '').replace(/\s+/g, ' ').trim(), top: Math.round(region.getBoundingClientRect().top) }
            : null;
        },
        OFFER,
      );
      await app.screenshot('setup-offer');

      // Followed from the page, not reopened: the same path and code.
      await follow.click();
      await expect(browser).toHaveURL(link.path);
      observed.followedTo = await here(browser);
      await expect(screen.getByText(link.code, { exact: true })).toBeVisible();
      await screen.getByRole('textbox', { name: 'Device name' }).fill(deviceName);
      await screen.getByRole('button', { name: 'Approve device' }).click();
      await expect(browser).toHaveURL('/setup');
      // Approving it is the end of the offer, for this code.
      await expect(screen.getByRole('region', { name: OFFER })).toBeHidden();
      expect(await heldLink(browser)).toBeNull();

      const linkExit = await link.cli.exited(60_000);
      // Found before the exit code is judged, so teardown has it either way.
      deviceId = await findAttemptDevice(portal, attempt);
      expect(linkExit, link.cli.output()).toBe(0);
      expect(link.cli.output()).toContain('Linked ');
      expect(deviceId, "the original code's approval created this attempt's device").toBeTruthy();
      expect(await pendingCode(browser, link.code)).toEqual({ valid: false, approved: false });

      const status = home.start(['status', '--portal', LOCAL_ORIGIN]);
      expect(await status.exited(30_000), status.output()).toBe(0);
      expect(status.output()).toContain(`Device   ${deviceName}`);
      expect(status.output()).toContain(`Team     ${TEAM}`);

      // The used code held again, as the guard stored it: Setup asks, hears
      // it's closed, offers nothing and forgets it.
      await browser.evaluate(
        ({ key, value }: { key: string; value: string }) => {
          sessionStorage.setItem(key, value);
          return null;
        },
        { key: HELD_KEY, value: JSON.stringify({ path: link.path, userCode: link.code, login: student }) },
      );
      const asked = browser.waitForResponse(new RegExp(`/api/v1/cli/device/status\\?user_code=${link.code}$`), { timeout: 15_000 });
      await app.open('/setup');
      await asked;
      await expect.poll(() => heldLink(browser), { message: 'the used code is still held' }).toBeNull();
      await expect(screen.getByRole('region', { name: OFFER })).toBeHidden();
      completed = true;
    } finally {
      console.log(`Observed: ${JSON.stringify(observed)}`);
      // Stop the CLI first, so it can't collect a token after the revoke.
      const closed = await home.close().then(
        () => undefined,
        (error: unknown) => error,
      );
      const problems: string[] = [];
      const revoked = attempt ? await revokeAttemptDevice(portal, attempt, deviceId) : undefined;
      if (revoked) problems.push(revoked);
      const left = await leaveIfOnTeam(browser, student);
      if (left) problems.push(left);
      if (closed) throw closed;
      if (problems.length > 0) {
        const message = `Teardown left this attempt's state behind: ${problems.join('; ')}`;
        if (completed) throw new Error(message);
        console.error(message);
      }
    }
  },
);

test(
  'the held link never reaches another account in the tab, and / and /signin never go to it',
  { timeout: 120_000 },
  async ({ app, browser, screen }) => {
    const home = await CliHome.create();
    const suffix = randomUUID().slice(0, 8);
    const student = `e2e-pilot-d-${suffix}`;
    const other = `e2e-pilot-d-${suffix}-x`;
    const observed: Record<string, unknown> = { student, other };
    let completed = false;
    try {
      // Nothing approves this code; the CLI is stopped at the end and the
      // code runs out on its own.
      const link = await startLink(home);
      observed.code = link.code;

      await app.open('/');
      await newStudent(browser, student);
      await app.open(link.path);
      await expect(browser).toHaveURL('/connect');
      expect(await heldLink(browser)).toEqual({ path: link.path, userCode: link.code, login: student });

      // Ordinary navigation with a held, still-open code: each page settles
      // where it would anyway. Two reads a second apart, so a page passing
      // through on its way somewhere else doesn't count as settled.
      for (const start of ['/', '/signin']) {
        await app.open(start);
        await browser.evaluate(() => new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)));
        const first = await here(browser);
        await browser.evaluate(() => new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)));
        const second = await here(browser);
        observed[`settled from ${start}`] = [first, second];
        expect(second, `${start} kept moving`).toBe(first);
        expect(first, `${start} went to the held approval`).not.toContain('user_code=');
      }
      expect(await heldLink(browser), 'ordinary navigation keeps the held link').toEqual({
        path: link.path,
        userCode: link.code,
        login: student,
      });

      // Another account signs in on the same tab, one with a team.
      await newStudent(browser, other);
      expect(await joinTeam(browser, TEAM_ID)).toBe(200);
      await app.open('/setup');
      await expect(screen.getByRole('heading', { name: 'Set up your machine' })).toBeVisible();
      await expect(screen.getByRole('region', { name: OFFER })).toBeHidden();
      await expect.poll(() => heldLink(browser), { message: "another account's visit left the link held" }).toBeNull();
      // The server was never told anything: the code is as open as before.
      expect(await pendingCode(browser, link.code)).toEqual({ valid: true, approved: false });

      // The first account back in the same tab: the link stays forgotten.
      expect(await devLogin(browser, student)).toBe(200);
      await app.open('/connect');
      expect(await heldLink(browser)).toBeNull();
      completed = true;
    } finally {
      console.log(`Observed: ${JSON.stringify(observed)}`);
      const closed = await home.close().then(
        () => undefined,
        (error: unknown) => error,
      );
      // One account at a time: both sign in on this tab's cookie.
      const problems: string[] = [];
      for (const login of [other, student]) {
        const left = await leaveIfOnTeam(browser, login);
        if (left) problems.push(left);
      }
      if (closed) throw closed;
      if (problems.length > 0) {
        const message = `Teardown left this attempt's state behind: ${problems.join('; ')}`;
        if (completed) throw new Error(message);
        console.error(message);
      }
    }
  },
);
