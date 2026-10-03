import type { Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliHome, CliProcess } from './cli.ts';
import { LOCAL_ORIGIN } from './local-origin.ts';

// Synthetic dev accounts on one synthetic team (fixtures/link-team.sql). The
// approval page needs a team, and so does `cogworks status`.
export const STUDENT = 'e2e-pilot-a';
export const TEAMMATE = 'e2e-pilot-b';
export const TEAM = 'E2E Pilot Team';
/** The name ConnectionsPage prefills. */
export const DEFAULT_DEVICE_NAME = 'CogWorks CLI';

export function devLogin(browser: Browser, login: string): Promise<number> {
  return browser.evaluate(
    (name: string) =>
      fetch('/api/dev/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: name }),
      }).then((response) => response.status),
    login,
  );
}

type Device = { id: string; name: string; createdAt: number };

export function cliDevices(browser: Browser): Promise<Device[]> {
  return browser.evaluate(() =>
    fetch('/api/v1/connections')
      .then((response) => response.json())
      .then((body: { cliDevices: Device[] }) =>
        body.cliDevices.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
      ),
  );
}

/**
 * Approves a printed code through the API as the signed-in student. For
 * tests about what happens after linking; the approval page itself is
 * covered by cli-link.e2e.ts and cli-link-keyboard.e2e.ts.
 */
export function approveDevice(browser: Browser, userCode: string): Promise<number> {
  return browser.evaluate(
    (code: string) =>
      fetch('/api/v1/cli/device/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCode: code, deviceName: 'E2E pilot CLI' }),
      }).then((response) => response.status),
    userCode,
  );
}

/** Signs in as `login` and revokes one of that person's devices; the status of the revoke. */
export async function revokeDevice(browser: Browser, login: string, deviceId: string): Promise<number> {
  const signedIn = await devLogin(browser, login);
  if (signedIn !== 200) return signedIn;
  return browser.evaluate(
    (id: string) =>
      fetch('/api/v1/cli/devices', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: id }),
      }).then((response) => response.status),
    deviceId,
  );
}

export interface PrintedLink {
  readonly cli: CliProcess;
  /** Path and query of the printed approval URL, for `app.open`. */
  readonly path: string;
  readonly code: string;
}

/** Starts `cogworks link` and reads the approval URL and code it prints (cli.py, the `link` branch). */
export async function startLink(home: CliHome): Promise<PrintedLink> {
  const cli = home.start(['link', '--portal', LOCAL_ORIGIN, '--no-browser']);
  const [, printed, code] = await cli.waitFor(/^Open (\S+) and confirm code (\S+)\.$/m, 30_000);
  // SAFETY: both groups are mandatory in the pattern, so a match carries them.
  const url = new URL(printed!);
  expect(url.origin, 'the printed link points at this portal').toBe(LOCAL_ORIGIN);
  return { cli, path: `${url.pathname}${url.search}`, code: code! };
}

/**
 * What shows that this run's approval happened, whatever the browser step
 * did or replayed: the CLI exits linked with a private credential file,
 * exactly one new device exists for the student, `status` answers with the
 * saved token, the teammate can't see the device, and revoking it stops the
 * token. Call with the student signed in; it leaves the student signed in.
 */
export async function expectCurrentApproval(options: {
  browser: Browser;
  home: CliHome;
  link: PrintedLink;
  devicesBefore: readonly string[];
  startedAt: number;
}): Promise<void> {
  const { browser, home, link, devicesBefore, startedAt } = options;
  expect(await link.cli.exited(60_000), link.cli.output()).toBe(0);
  expect(link.cli.output()).toContain('Linked ');
  expect((await stat(join(home.path, '.cogbench'))).mode & 0o777).toBe(0o700);
  expect((await stat(join(home.path, '.cogbench', 'config.json'))).mode & 0o777).toBe(0o600);

  const fresh = (await cliDevices(browser)).filter((device) => !devicesBefore.includes(device.id));
  expect(fresh, 'exactly one device appeared for this approval').toHaveLength(1);
  // SAFETY: toHaveLength(1) above throws unless there is exactly one.
  const device = fresh[0]!;
  expect(device.name).toBe(DEFAULT_DEVICE_NAME);
  expect(device.createdAt).toBeGreaterThanOrEqual(startedAt);

  const status = home.start(['status', '--portal', LOCAL_ORIGIN]);
  expect(await status.exited(30_000), status.output()).toBe(0);
  expect(status.output()).toContain(`Device   ${DEFAULT_DEVICE_NAME}`);
  expect(status.output()).toContain(`Team     ${TEAM}`);

  // Devices belong to the person, not the team.
  expect(await devLogin(browser, TEAMMATE)).toBe(200);
  expect((await cliDevices(browser)).map((each) => each.id)).not.toContain(device.id);

  expect(await revokeDevice(browser, STUDENT, device.id)).toBe(200);
  const afterRevoke = home.start(['status', '--portal', LOCAL_ORIGIN]);
  expect(await afterRevoke.exited(30_000), afterRevoke.output()).toBe(2);
}
