import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { randomUUID } from 'node:crypto';
import { joinCohort, leaveTeam, pendingCode, sessionState } from '../support/accounts.ts';
import { CliHome } from '../support/cli.ts';
import { findAttemptDevice, revokeAttemptDevice, type AttemptDevice } from '../support/devices.ts';
import { TEAM, browserPortal, devLogin, startLink } from '../support/link.ts';
import { LOCAL_ORIGIN } from '../support/local-origin.ts';

// A student runs `cogworks link` before joining a team. The approval page
// needs a team, so the stage guard sends them on to Connect and leaves only a
// note that a device link was dropped (src/lib/pending-return.ts). The
// authorization itself survives: the same code still approves once they
// return to the printed link. This walks that recovery as it exists today:
// the printed link as a cohort member with no team, the notice, joining the
// existing team through the UI (the agent's step), where the app goes next,
// then the same printed link again, approved, with the terminal linked.
// Nothing here asks the app to resume the link by itself.
//
// Each attempt is a new account, so its membership and device are its own
// and teardown can remove exactly those. The two link-team students are
// never touched.
const COHORT_CODE = 'VISION26'; // apps/portal/scripts/seed-local.sql
const COHORT = 'bwsi-2026';
const TEAM_ID = 'team_e2e_pilot'; // fixtures/link-team.sql

test(
  'a teamless student links the CLI by joining a team and reopening the printed link',
  { timeout: 240_000 },
  async ({ app, agent, browser, screen }) => {
    const home = await CliHome.create();
    const portal = browserPortal(browser);
    const suffix = randomUUID().slice(0, 8);
    const student = `e2e-pilot-c-${suffix}`;
    const deviceName = `E2E pilot ${suffix}`;
    const observed: Record<string, unknown> = { student };
    let attempt: AttemptDevice | undefined;
    let deviceId: string | undefined;
    let completed = false;
    try {
      const link = await startLink(home);
      observed.code = link.code;

      // A cohort member with no team, the account the printed link reaches.
      await app.open('/');
      expect(await devLogin(browser, student)).toBe(200);
      expect(await joinCohort(browser, COHORT_CODE)).toBe(200);
      expect(await sessionState(browser)).toEqual({ cohort: COHORT, team: null });
      // A new account has no devices, so any device under this name is this attempt's.
      attempt = { login: student, before: [], name: deviceName };

      // The printed link, opened with no team: sent to Connect, told why.
      await app.open(link.path);
      await expect(browser).toHaveURL('/connect');
      const hold = screen.getByText('Your device link is on hold');
      await expect(hold).toBeVisible();
      await expect(screen.getByText('It needs a team first.', { exact: false })).toBeVisible();
      observed.afterPrintedLink = await browser.url();
      observed.notice = await browser.evaluate(() =>
        Array.from(document.querySelectorAll('[role="status"]'))
          .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
          .find((text) => text.startsWith('Your device link is on hold')) ?? null,
      );
      await app.screenshot('dropped-link-notice');
      // Dropped from the browser, not from the server: still open, unapproved.
      expect(await pendingCode(browser, link.code)).toEqual({ valid: true, approved: false });

      // The agent joins the existing team through the UI.
      await agent.act('join the team called {team}', {
        params: { team: TEAM },
        maxSteps: 8,
        maxModelCalls: 10,
        timeout: 90_000,
      });
      // ConnectPage sends a student who joins to Setup (joinTeam, onSuccess).
      await expect(browser).toHaveURL('/setup');
      expect(await sessionState(browser)).toEqual({ cohort: COHORT, team: { id: TEAM_ID, name: TEAM } });
      observed.afterJoining = await browser.url();
      // Whether the page shows the held code or links back to its approval.
      // Setup's own `cogworks link` step and its terminal indicator are
      // generic, so they don't count.
      observed.afterJoiningShowsHeldCode = await browser.evaluate(
        (code: string) => (document.querySelector('main')?.textContent ?? '').includes(code),
        link.code,
      );
      observed.afterJoiningLinksToApproval = await browser.evaluate(() =>
        Boolean(document.querySelector('main a[href*="user_code="]')),
      );
      await app.screenshot('after-joining');
      expect(await pendingCode(browser, link.code)).toEqual({ valid: true, approved: false });

      // The same printed link again: the original code, approved from the page.
      await app.open(link.path);
      await expect(browser).toHaveURL(link.path);
      await expect(screen.getByText(link.code)).toBeVisible();
      await screen.getByRole('textbox', { name: 'Device name' }).fill(deviceName);
      await screen.getByRole('button', { name: 'Approve device' }).click();
      await expect(browser).toHaveURL('/setup');

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
      completed = true;
    } finally {
      console.log(`Observed: ${JSON.stringify(observed)}`);
      // Stop the CLI first, so it can't collect a token after the revoke.
      // Then this attempt's device, then this account's membership: both
      // belong only to this attempt.
      const closed = await home.close().then(
        () => undefined,
        (error: unknown) => error,
      );
      const problems: string[] = [];
      const revoked = attempt ? await revokeAttemptDevice(portal, attempt, deviceId) : undefined;
      if (revoked) problems.push(revoked);
      try {
        if ((await devLogin(browser, student)) === 200) {
          const { team } = await sessionState(browser);
          if (team) {
            const left = await leaveTeam(browser, team.id);
            if (left !== 200) problems.push(`leaving ${team.id} returned ${left}`);
          }
        }
      } catch (error) {
        problems.push(`checking ${student}'s team: ${String(error)}`);
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
