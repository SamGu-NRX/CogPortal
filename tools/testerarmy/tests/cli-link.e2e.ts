import { test } from '@e2e-dev/web';
import { expect, unique } from 'e2e';
import { CliHome } from '../support/cli.ts';
import { STUDENT, cliDevices, devLogin, expectCurrentApproval, startLink } from '../support/link.ts';

// The approval a student actually does. `cogworks link` prints a URL
// and a code; the student opens that URL signed in, checks the code and
// approves. The agent does the approving. Its step may be replayed from the
// cache, and a replayed step's summary repeats the recorded run's verdict, so
// nothing here trusts it: expectCurrentApproval checks the terminal and the
// server for this run's approval.
//
// The agent tends to approve with targeted key presses (Enter on the button
// itself), which shows keyboard activation but not tab order;
// cli-link-keyboard.e2e.ts covers tab order without a model.
test('a student links the CLI by approving the printed code with the keyboard', async ({
  app,
  agent,
  browser,
  screen,
}) => {
  const home = await CliHome.create();
  try {
    const link = await startLink(home);
    await app.open('/');
    expect(await devLogin(browser, STUDENT)).toBe(200);
    const devicesBefore = (await cliDevices(browser)).map((device) => device.id);
    const startedAt = Date.now();

    await app.open(link.path);
    await expect(screen.getByText(link.code)).toBeVisible();

    await agent.act('check that the page asks to approve code {code}, then approve this device using only the keyboard', {
      params: { code: unique(link.code) },
      maxSteps: 8,
      maxModelCalls: 10,
      timeout: 90_000,
    });
    // The page confirms, then returns to Setup after 900 ms (ConnectionsPage).
    await expect(browser).toHaveURL('/setup');

    await expectCurrentApproval({ browser, home, link, devicesBefore, startedAt });
  } finally {
    await home.close();
  }
});
