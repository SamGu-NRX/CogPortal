import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { CliHome } from '../support/cli.ts';
import { STUDENT, cliDevices, devLogin, expectCurrentApproval, startLink } from '../support/link.ts';

// The same approval as cli-link.e2e.ts, done from the keyboard in the page's
// own tab order and with no model: focus the device name once, press Tab on
// whatever has focus until the approve button has it, then press Enter. The
// sequence of focused controls is printed and must be exactly one stop.
const TARGET = 'button "Approve device"';
const MAX_TABS = 10;

/** The focused element as role and name, close enough to tell controls on this page apart. */
function describeFocus(): string {
  const element = document.activeElement;
  if (!element || element === document.body) return 'body';
  const role = element.getAttribute('role') ?? element.tagName.toLowerCase();
  const name = element.getAttribute('aria-label') ?? (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  return `${role} "${name || element.id}"`;
}

test('a student approves the printed code from the keyboard in tab order', async ({ app, browser, screen }) => {
  const home = await CliHome.create();
  try {
    const link = await startLink(home);
    await app.open('/');
    expect(await devLogin(browser, STUDENT)).toBe(200);
    const devicesBefore = (await cliDevices(browser)).map((device) => device.id);
    const startedAt = Date.now();

    await app.open(link.path);
    await expect(screen.getByText(link.code)).toBeVisible();

    const field = screen.getByRole('textbox', { name: 'Device name' });
    await field.focus();
    await expect(field).toBeFocused();
    const sequence: string[] = [];
    for (let presses = 0; presses < MAX_TABS; presses++) {
      await browser.keyboard.press('Tab');
      const focused = await browser.evaluate(describeFocus);
      sequence.push(focused);
      if (focused === TARGET) break;
    }
    console.log(`Tab order from "Device name": ${sequence.join(' -> ')}`);
    expect(sequence, 'one Tab from the device name reaches the approve button').toEqual([TARGET]);
    await expect(screen.getByRole('button', { name: 'Approve device' })).toBeFocused();

    await browser.keyboard.press('Enter');
    await expect(screen.getByText('Device approved', { exact: false })).toBeVisible();
    await expect(browser).toHaveURL('/setup');

    await expectCurrentApproval({ browser, home, link, devicesBefore, startedAt });
  } finally {
    await home.close();
  }
});
